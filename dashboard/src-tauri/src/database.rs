//! The one process that holds the SQLite connection.
//!
//! The webview never touches the file; it sends SQL text through the `db_select`
//! and `db_execute` commands, so everything arriving here is untrusted input
//! from a renderer. `validate_sql` and `validate_mutation_target` are the whole
//! boundary between that and the user's data — read both before changing either.
//!
//! The bootstrap schema below is duplicated in `tracker/db.py`, because either
//! half may legitimately create the database first (dashboard opened before the
//! tracker's first run, or the reverse). The two must stay identical; the
//! Python side owns migrations.

use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Column, Row, SqlitePool, TypeInfo, Value, ValueRef,
};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const SCHEMA_VERSION: i64 = 4;
const MAX_SESSION_SPAN_SEC: i64 = 7 * 86_400;

fn schedule_minute(raw: &str, fallback: u32) -> u32 {
    raw.parse::<u32>()
        .ok()
        .filter(|minute| *minute < 24 * 60)
        .unwrap_or(fallback)
}

fn schedule_allows_local(
    enabled: bool,
    days_raw: &str,
    start_raw: &str,
    end_raw: &str,
    weekday: u32,
    minute: u32,
) -> bool {
    if !enabled {
        return true;
    }
    let days = days_raw
        .split(',')
        .filter_map(|value| value.trim().parse::<u32>().ok())
        .filter(|day| *day <= 6)
        .collect::<HashSet<_>>();
    let start = schedule_minute(start_raw, 9 * 60);
    let end = schedule_minute(end_raw, 17 * 60);
    if days.is_empty() || start == end {
        return false;
    }
    if start < end {
        days.contains(&weekday) && start <= minute && minute < end
    } else {
        (days.contains(&weekday) && minute >= start)
            || (days.contains(&((weekday + 6) % 7)) && minute < end)
    }
}

const BOOTSTRAP_SQL: &str = r#"
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL CHECK(end_ts >= start_ts),
    process TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    domain TEXT,
    is_afk INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_ts);
CREATE INDEX IF NOT EXISTS idx_sessions_proc ON sessions(process);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    is_productive INTEGER NOT NULL DEFAULT 0,
    is_neutral INTEGER NOT NULL DEFAULT 0,
    is_ignored INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY,
    match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),
    pattern TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    priority INTEGER NOT NULL DEFAULT 0,
    -- Window-only matching and scope fields. Empty strings on App/Website
    -- rules keep the contract explicit and make the composite UNIQUE stable.
    scope_kind TEXT NOT NULL DEFAULT ''
        CHECK(scope_kind IN ('','any','browsers','process','domain')),
    scope_value TEXT NOT NULL DEFAULT '',
    title_match_mode TEXT NOT NULL DEFAULT ''
        CHECK(title_match_mode IN ('','segment','phrase','contains')),
    title_anchor TEXT NOT NULL DEFAULT ''
        CHECK(title_anchor IN ('','any','first','interior','last')),
    CHECK (
        (
            match_type = 'title'
            AND scope_kind IN ('any','browsers','process','domain')
            AND title_match_mode IN ('segment','phrase','contains')
            AND title_anchor IN ('any','first','interior','last')
            AND (title_match_mode = 'segment' OR title_anchor = 'any')
            AND (
                (scope_kind IN ('any','browsers') AND scope_value = '')
                OR (scope_kind IN ('process','domain') AND length(scope_value) > 0)
            )
        )
        OR
        (
            match_type <> 'title'
            AND scope_kind = ''
            AND scope_value = ''
            AND title_match_mode = ''
            AND title_anchor = ''
        )
    ),
    UNIQUE(
        match_type, pattern, scope_kind, scope_value,
        title_match_mode, title_anchor
    )
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TRIGGER IF NOT EXISTS delete_category_rules
BEFORE DELETE ON categories FOR EACH ROW BEGIN
    DELETE FROM rules WHERE category_id = OLD.id;
END;
CREATE TABLE IF NOT EXISTS tracking_exclusions (
    kind TEXT NOT NULL CHECK(kind IN ('app','website')),
    pattern TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    PRIMARY KEY(kind, pattern)
);
CREATE TABLE IF NOT EXISTS session_corrections (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    corrected_start_ts INTEGER,
    corrected_end_ts INTEGER,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    updated_ts INTEGER NOT NULL,
    CHECK (
        (corrected_start_ts IS NULL AND corrected_end_ts IS NULL)
        OR
        (corrected_start_ts IS NOT NULL AND corrected_end_ts IS NOT NULL
         AND corrected_end_ts > corrected_start_ts)
    )
);
CREATE INDEX IF NOT EXISTS idx_session_corrections_category
    ON session_corrections(category_id);
CREATE TRIGGER IF NOT EXISTS cleanup_empty_session_corrections
AFTER DELETE ON categories FOR EACH ROW BEGIN
    DELETE FROM session_corrections
    WHERE corrected_start_ts IS NULL AND corrected_end_ts IS NULL AND category_id IS NULL;
END;
INSERT OR IGNORE INTO settings (key,value)
    SELECT 'starter_categories_pending','1'
    WHERE NOT EXISTS (SELECT 1 FROM categories);
WITH starter(name, color, is_productive, is_neutral, is_ignored, sort_order) AS (
    VALUES
        -- Mirrors _SEED_CATEGORIES in tracker/db.py, which explains why these
        -- names describe kinds of application rather than kinds of intent.
        -- Either half may create the database, so the two lists must agree.
        ('Work', '#2f6fc0', 1, 0, 0, 1),
        ('Communication', '#56c8d8', 0, 1, 0, 2),
        ('Browsing', '#e0a53a', 0, 1, 0, 3),
        ('Entertainment', '#e75fa0', 0, 0, 0, 4),
        ('System', '#828994', 0, 1, 0, 5),
        ('Ignored', '#44474e', 0, 0, 1, 99)
)
INSERT OR IGNORE INTO categories
    (name, color, is_productive, is_neutral, is_ignored, sort_order)
    SELECT * FROM starter
    WHERE (SELECT COUNT(*) FROM categories) = 0;
INSERT OR IGNORE INTO settings (key,value) VALUES
    -- Must track SCHEMA_VERSION above: this is what a database created by the
    -- dashboard rather than the tracker is stamped with, and open() refuses
    -- anything older than the constant.
    ('schema_version','4'),
    ('rule_priority_scheme','low-wins-v1'),
    ('weekly_goal_hours','0'),
    ('idle_threshold_seconds','300'),
    ('heartbeat_seconds','15'),
    ('week_start','auto'),
    ('browser_processes','chrome.exe,msedge.exe,firefox.exe,opera.exe,brave.exe,vivaldi.exe'),
    ('min_app_seconds_per_day','0'),
    ('activity_noise_filter','utilities'),
    ('activity_noise_max_seconds','120'),
    ('activity_noise_max_sessions','1'),
    ('color_palette','slate'),
    ('productivity_style','vivid'),
    ('theme','system'),
    ('focus_chain_max_gap_seconds','300'),
    ('day_start_hour','0'),
    ('day_end_hour','24'),
    ('tracking_paused','0'),
    ('tracking_paused_until','0'),
    ('tracking_schedule_enabled','0'),
    ('tracking_schedule_days','0,1,2,3,4'),
    ('tracking_schedule_start_minute','540'),
    ('tracking_schedule_end_minute','1020'),
    ('recording_consent','0'),
    ('record_window_titles','0'),
    ('privacy_onboarding_complete','0'),
    ('launch_at_login','0'),
    ('show_tray_icon','1'),
    ('check_updates_automatically','1');
COMMIT;
"#;

pub struct TimeDatabase {
    pool: SqlitePool,
    path: PathBuf,
    schema_version: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub modified_sec: i64,
    pub bytes: u64,
    pub schema_version: Option<i64>,
    pub compatible: bool,
    pub issue: Option<String>,
    pub legacy_location: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestore {
    pub source_name: String,
    pub safety_backup_path: String,
    pub schema_version: i64,
    pub recording_consent: bool,
    pub launch_at_login: bool,
}

pub struct RestoreSwap {
    pub pending: PendingRestore,
    rollback_path: PathBuf,
    marker_path: PathBuf,
    database_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreNotice {
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

/// Columnar session transport keeps the largest dashboard read compact. The
/// generic SELECT bridge builds a string-keyed JSON map for every row; sending
/// each column once avoids that repeated allocation and repeated field names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionColumns {
    ids: Vec<i64>,
    starts: Vec<i64>,
    ends: Vec<i64>,
    processes: Vec<String>,
    titles: Vec<String>,
    domains: Vec<Option<String>>,
    is_afk: Vec<bool>,
    category_override_ids: Vec<Option<i64>>,
    is_corrected: Vec<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingExclusion {
    pub kind: String,
    pub pattern: String,
    pub created_ts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingExclusionPreview {
    pub count: u64,
    pub seconds: i64,
    pub normalized_pattern: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingExclusionResult {
    pub normalized_pattern: String,
    pub deleted_count: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCorrectionRequest {
    pub session_id: i64,
    pub start_sec: f64,
    pub end_sec: f64,
    pub category_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCorrection {
    pub session_id: i64,
    pub original_start: i64,
    pub original_end: i64,
    pub start: i64,
    pub end: i64,
    pub process: String,
    pub title: String,
    pub domain: Option<String>,
    pub category_id: Option<i64>,
    pub is_afk: bool,
    pub is_live: bool,
    pub is_corrected: bool,
    /// The free gap around this session: the end of the nearest session before
    /// it, and the start of the nearest one after. Corrected times may not
    /// overlap another recording, and because the tracker records continuously
    /// that gap is usually the session's own span — so the interface states the
    /// limit up front rather than letting every edit be rejected after the
    /// fact. `None` means nothing is recorded on that side.
    pub earliest_start: Option<i64>,
    pub latest_end: Option<i64>,
}

/// A category applied to many sessions at once, leaving their recorded times
/// alone. `correct_session` is the one-session form and takes a span with it,
/// which drags in the overlap and future-time checks a reclassification has no
/// business re-running — and would re-run per session, over the whole timeline.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClassificationRequest {
    pub session_ids: Vec<i64>,
    /// `None` clears the override, returning each session to the rules.
    pub category_id: Option<i64>,
}

/// One session's override as it stood before a batch changed it. The caller
/// keeps these to offer an undo; they are the only record of the previous
/// state, since a correction row stores no history of its own.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClassification {
    pub session_id: i64,
    pub category_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClassificationResult {
    pub changed_count: u64,
    /// AFK rows and the live session, which are not editable. Counted rather
    /// than refused: a selection is made over what was on screen, and one
    /// untouchable row in it should not cost the other three hundred.
    pub skipped_count: u64,
    pub previous: Vec<SessionClassification>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeleteRequest {
    pub mode: String,
    #[serde(default)]
    pub session_ids: Vec<i64>,
    pub entity_kind: Option<String>,
    pub entity_key: Option<String>,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    #[serde(default)]
    pub browser_processes: Vec<String>,
    pub snapshot_max_id: Option<i64>,
    pub preview_protected_session_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeletePreview {
    pub count: u64,
    pub seconds: i64,
    pub earliest_start: Option<i64>,
    pub latest_end: Option<i64>,
    pub protected_count: u64,
    pub snapshot_max_id: i64,
    pub protected_session_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeleteResult {
    pub deleted_count: u64,
    pub protected_count: u64,
}

#[derive(Clone)]
struct DeletionCandidate {
    id: i64,
    start: i64,
    end: i64,
}

/// Ids bound per statement. SQLite's default SQLITE_MAX_VARIABLE_NUMBER is the
/// ceiling being kept under; the exact figure matters less than that every
/// chunked statement uses the same one.
const ID_CHUNK: usize = 500;

/// `?,?,?` for a chunk of `count` values, or `count` copies of a wider `unit`
/// such as `(?,NULL,NULL,?,?)` for a multi-column insert.
fn placeholders(count: usize, unit: &str) -> String {
    std::iter::repeat_n(unit, count)
        .collect::<Vec<_>>()
        .join(",")
}

/// The span a session is treated as occupying: its correction when one exists,
/// otherwise what was recorded. Every surface that reports, previews or deletes
/// time has to answer this the same way, so it is written once rather than
/// retyped per query.
const EFFECTIVE_SPAN: &str = "COALESCE(c.corrected_start_ts,s.start_ts) AS effective_start, \
     COALESCE(c.corrected_end_ts,s.end_ts) AS effective_end";

/// Sessions with their correction attached when there is one.
const CORRECTED_JOIN: &str = "FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id";

/// Overlaps a half-open window. Binds in order: window start, then window end.
/// Touching endpoints do not overlap, which is what makes a correction that
/// begins exactly where its neighbour ends legal.
const OVERLAPS_WINDOW: &str = "COALESCE(c.corrected_end_ts,s.end_ts)>? \
     AND COALESCE(c.corrected_start_ts,s.start_ts)<?";

impl TimeDatabase {
    /// Tests hand the closed file straight to a restore path, which validates it
    /// through a read-only connection. A read-only connection cannot build the
    /// shared-memory index a `-wal` needs, so it would read the main file alone
    /// and report a database with no `settings` table. Fold the WAL back in
    /// first; closing the pool alone only checkpoints on a timing the suite
    /// does not control.
    #[cfg(test)]
    pub async fn close(self) {
        let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await;
        self.pool.close().await;
    }

    pub async fn open(path: PathBuf) -> Result<Self, String> {
        let preexisting = path.metadata().map(|meta| meta.len() > 0).unwrap_or(false);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(30))
            .pragma("secure_delete", "ON");
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|error| error.to_string())?;
        let schema_version = if preexisting {
            let settings_exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            )
            .fetch_one(&pool)
            .await
            .map_err(|error| error.to_string())?;
            if settings_exists == 0 {
                let user_tables: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .fetch_one(&pool)
                .await
                .map_err(|error| error.to_string())?;
                if user_tables == 0 {
                    SCHEMA_VERSION
                } else {
                    return Err(
                        "Unversioned pre-release database; migrate it before running this release"
                            .to_owned(),
                    );
                }
            } else {
                let raw_version = sqlx::query_scalar::<_, String>(
                    "SELECT value FROM settings WHERE key='schema_version'",
                )
                .fetch_optional(&pool)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    "Unversioned pre-release database; migrate it before running this release"
                        .to_owned()
                })?;
                let version = raw_version
                    .parse::<i64>()
                    .map_err(|_| "Database schema_version is not a valid integer".to_owned())?;
                // A too-new database opens successfully on purpose. Failing
                // here would leave the app unable to start and unable to say
                // why; instead the version is carried on the handle, reads keep
                // working, and `ensure_writable_schema` blocks every write so
                // the UI can show the "needs a newer Time" screen. Returning
                // early also skips the bootstrap SQL below, which must not run
                // against a schema this release does not understand.
                if version > SCHEMA_VERSION {
                    return Ok(Self {
                        pool,
                        path,
                        schema_version: version,
                    });
                }
                if version < SCHEMA_VERSION {
                    return Err(format!(
                    "Database schema {version} requires an explicit migration to {SCHEMA_VERSION}"
                ));
                }
                version
            }
        } else {
            SCHEMA_VERSION
        };
        sqlx::raw_sql(BOOTSTRAP_SQL)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            pool,
            path,
            schema_version,
        })
    }

    /// First gate: the statement is a single one, of an allowed verb, with no
    /// way to reach outside the current database.
    ///
    /// Rejecting `;` and comment markers is what makes the single-verb check
    /// meaningful — without it, `SELECT 1; DROP TABLE sessions` passes as a
    /// SELECT, and a comment can hide a second statement from the eye without
    /// hiding it from SQLite. ATTACH/DETACH would reach other files,
    /// LOAD_EXTENSION would load code, and PRAGMA/VACUUM would let the webview
    /// change durability or rewrite the file. The prefix check catches the
    /// `load_extension`-style variants of each.
    ///
    /// This is a keyword denylist over a fixed set of queries this app issues,
    /// not a SQL parser. Widening `allowed` means re-reading it in that light.
    fn validate_sql(query: &str, allowed: &[&str]) -> Result<(), String> {
        let trimmed = query.trim();
        let upper = trimmed.to_ascii_uppercase();
        let verb = upper.split_whitespace().next().unwrap_or("");
        if !allowed.contains(&verb) {
            return Err(format!("SQL operation {verb:?} is not allowed"));
        }
        if trimmed.contains(';') || upper.contains("--") || upper.contains("/*") {
            return Err("Multiple statements and SQL comments are not allowed".into());
        }
        for forbidden in ["ATTACH", "DETACH", "PRAGMA", "LOAD_EXTENSION", "VACUUM"] {
            if upper
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|token| token == forbidden || token.starts_with(&format!("{forbidden}_")))
            {
                return Err(format!(
                    "SQL keyword {forbidden} is not allowed from the webview"
                ));
            }
        }
        Ok(())
    }

    pub async fn select(
        &self,
        query_text: String,
        values: Vec<JsonValue>,
    ) -> Result<Vec<Map<String, JsonValue>>, String> {
        Self::validate_sql(&query_text, &["SELECT"])?;
        let mut query = sqlx::query(&query_text);
        for value in values {
            query = bind_value(query, value)?;
        }
        let rows = query
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        rows.into_iter()
            .map(|row| {
                let mut out = Map::new();
                for (index, column) in row.columns().iter().enumerate() {
                    let raw = row.try_get_raw(index).map_err(|error| error.to_string())?;
                    out.insert(column.name().to_owned(), sqlite_value_to_json(raw)?);
                }
                Ok(out)
            })
            .collect()
    }

    pub async fn fetch_sessions(
        &self,
        start_sec: f64,
        end_sec: f64,
        min_start_sec: f64,
    ) -> Result<SessionColumns, String> {
        if !start_sec.is_finite()
            || !end_sec.is_finite()
            || !min_start_sec.is_finite()
            || end_sec <= start_sec
        {
            return Err("Invalid session window".into());
        }
        // Split by whether a correction exists, rather than filtering on
        // COALESCE over the joined column. COALESCE is not sargable, so the
        // single-query form scanned every row of `sessions` no matter how
        // narrow the window: on a ten-year database a one-row live-edge refresh
        // cost ~138 ms, all of it scan. Filtering the uncorrected branch on
        // s.start_ts directly lets idx_sessions_start drive it — the same
        // refresh measures ~0.2 ms — and the corrected branch stays exact by
        // keeping the COALESCE, driven from session_corrections, which holds
        // one row per *edited* session rather than one per session.
        //
        // session_corrections.session_id is the primary key, so the branches
        // are disjoint and UNION ALL needs no deduplication.
        let rows = sqlx::query(
            "SELECT s.id,s.start_ts AS effective_start,s.end_ts AS effective_end, \
             s.process,s.title,s.domain,s.is_afk,NULL AS category_id,0 AS is_corrected \
             FROM sessions s \
             WHERE s.end_ts>? AND s.start_ts<? AND s.start_ts>? \
             AND NOT EXISTS (SELECT 1 FROM session_corrections c WHERE c.session_id=s.id) \
             UNION ALL \
             SELECT s.id,COALESCE(c.corrected_start_ts,s.start_ts), \
             COALESCE(c.corrected_end_ts,s.end_ts),s.process,s.title,s.domain, \
             s.is_afk,c.category_id,1 \
             FROM session_corrections c JOIN sessions s ON s.id=c.session_id \
             WHERE COALESCE(c.corrected_end_ts,s.end_ts)>? \
             AND COALESCE(c.corrected_start_ts,s.start_ts)<? \
             AND COALESCE(c.corrected_start_ts,s.start_ts)>? \
             ORDER BY effective_start ASC,id ASC",
        )
        .bind(start_sec)
        .bind(end_sec)
        .bind(min_start_sec)
        .bind(start_sec)
        .bind(end_sec)
        .bind(min_start_sec)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;

        let mut out = SessionColumns {
            ids: Vec::with_capacity(rows.len()),
            starts: Vec::with_capacity(rows.len()),
            ends: Vec::with_capacity(rows.len()),
            processes: Vec::with_capacity(rows.len()),
            titles: Vec::with_capacity(rows.len()),
            domains: Vec::with_capacity(rows.len()),
            is_afk: Vec::with_capacity(rows.len()),
            category_override_ids: Vec::with_capacity(rows.len()),
            is_corrected: Vec::with_capacity(rows.len()),
        };
        for row in rows {
            out.ids
                .push(row.try_get("id").map_err(|error| error.to_string())?);
            out.starts.push(
                row.try_get("effective_start")
                    .map_err(|error| error.to_string())?,
            );
            out.ends.push(
                row.try_get("effective_end")
                    .map_err(|error| error.to_string())?,
            );
            out.processes
                .push(row.try_get("process").map_err(|error| error.to_string())?);
            out.titles
                .push(row.try_get("title").map_err(|error| error.to_string())?);
            out.domains
                .push(row.try_get("domain").map_err(|error| error.to_string())?);
            let is_afk: i64 = row.try_get("is_afk").map_err(|error| error.to_string())?;
            out.is_afk.push(is_afk != 0);
            out.category_override_ids.push(
                row.try_get("category_id")
                    .map_err(|error| error.to_string())?,
            );
            let is_corrected: i64 = row
                .try_get("is_corrected")
                .map_err(|error| error.to_string())?;
            out.is_corrected.push(is_corrected != 0);
        }
        Ok(out)
    }

    pub async fn execute(
        &self,
        query_text: String,
        values: Vec<JsonValue>,
    ) -> Result<ExecuteResult, String> {
        self.ensure_writable_schema()?;
        Self::validate_sql(&query_text, &["INSERT", "UPDATE", "DELETE"])?;
        Self::validate_mutation_target(&query_text)?;
        let mut query = sqlx::query(&query_text);
        for value in values {
            query = bind_value(query, value)?;
        }
        let result = query
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(ExecuteResult {
            rows_affected: result.rows_affected(),
            last_insert_id: result.last_insert_rowid(),
        })
    }

    /// Second gate: which tables the webview may write, per verb.
    ///
    /// The asymmetries are deliberate. `settings` accepts INSERT (the dashboard
    /// upserts preferences) but not UPDATE or DELETE, so no renderer bug can
    /// blank a privacy gate or the schema version. Session deletion uses fixed,
    /// structured native commands instead of renderer-authored SQL; the tracker
    /// remains the sole author of session rows.
    ///
    /// The shape match reads the target table positionally, so a statement it
    /// cannot parse is rejected rather than allowed by default.
    fn validate_mutation_target(query: &str) -> Result<(), String> {
        let words = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_uppercase)
            .collect::<Vec<_>>();
        // Statement shape and the tables it may touch, together: settings
        // accepts INSERT but not UPDATE or DELETE, and that asymmetry is only
        // readable if the verb and its table list sit on the same arm.
        let (target, allowed_tables): (&str, &[&str]) = match words.as_slice() {
            [verb, into, table, ..] if verb == "INSERT" && into == "INTO" => {
                (table.as_str(), &["SETTINGS", "RULES", "CATEGORIES"])
            }
            [verb, table, ..] if verb == "UPDATE" => (table.as_str(), &["RULES", "CATEGORIES"]),
            [verb, from, table, ..] if verb == "DELETE" && from == "FROM" => {
                (table.as_str(), &["RULES", "CATEGORIES"])
            }
            _ => return Err("Unsupported SQL mutation shape".into()),
        };
        if !allowed_tables.contains(&target) {
            return Err(format!(
                "Webview mutations of table {target:?} are not allowed"
            ));
        }
        Ok(())
    }

    async fn activity_delete_candidates(
        &self,
        request: &ActivityDeleteRequest,
    ) -> Result<Vec<DeletionCandidate>, String> {
        if request.mode == "sessions" {
            if request.session_ids.is_empty() {
                return Err("Select at least one session".into());
            }
            if request.session_ids.len() > 100_000 {
                return Err("Too many sessions selected at once".into());
            }
            let mut unique = request.session_ids.iter().copied().collect::<HashSet<_>>();
            unique.retain(|id| *id > 0);
            let ids = unique.into_iter().collect::<Vec<_>>();
            let mut candidates = Vec::new();
            for chunk in ids.chunks(ID_CHUNK) {
                let placeholders = placeholders(chunk.len(), "?");
                let sql = format!(
                    "SELECT s.id,{EFFECTIVE_SPAN} {CORRECTED_JOIN} \
                     WHERE s.id IN ({placeholders})"
                );
                let mut query = sqlx::query(&sql);
                for id in chunk {
                    query = query.bind(id);
                }
                for row in query
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    candidates.push(DeletionCandidate {
                        id: row.try_get("id").map_err(|error| error.to_string())?,
                        start: row
                            .try_get("effective_start")
                            .map_err(|error| error.to_string())?,
                        end: row
                            .try_get("effective_end")
                            .map_err(|error| error.to_string())?,
                    });
                }
            }
            return Ok(candidates);
        }

        if request.mode != "entity" {
            return Err("Unsupported Activity deletion mode".into());
        }
        let entity_kind = request
            .entity_kind
            .as_deref()
            .ok_or("Missing entity kind")?;
        let entity_key = request
            .entity_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .ok_or("Missing entity key")?
            .to_ascii_lowercase();
        let start_sec = request.start_sec.ok_or("Missing deletion start")?;
        let end_sec = request.end_sec.ok_or("Missing deletion end")?;
        if !start_sec.is_finite() || !end_sec.is_finite() || end_sec <= start_sec {
            return Err("Invalid Activity deletion range".into());
        }
        let browser_processes = request
            .browser_processes
            .iter()
            .map(|process| process.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let predicate = match entity_kind {
            "app" => "lower(s.process)=?",
            "website" => "lower(IFNULL(s.domain,''))=?",
            _ => return Err("Unsupported Activity entity kind".into()),
        };
        let sql = format!(
            "SELECT s.id,{EFFECTIVE_SPAN},s.process,s.domain {CORRECTED_JOIN} \
             WHERE {predicate} AND {OVERLAPS_WINDOW}"
        );
        let rows = sqlx::query(&sql)
            .bind(&entity_key)
            .bind(start_sec)
            .bind(end_sec)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        let mut candidates = Vec::new();
        for row in rows {
            let process = row
                .try_get::<String, _>("process")
                .map_err(|error| error.to_string())?
                .to_ascii_lowercase();
            let domain = row
                .try_get::<Option<String>, _>("domain")
                .map_err(|error| error.to_string())?;
            let has_domain = domain.as_deref().is_some_and(|value| !value.is_empty());
            let belongs = match entity_kind {
                "app" => !browser_processes.contains(&process) || !has_domain,
                "website" => browser_processes.contains(&process) && has_domain,
                _ => false,
            };
            if belongs {
                candidates.push(DeletionCandidate {
                    id: row.try_get("id").map_err(|error| error.to_string())?,
                    start: row
                        .try_get("effective_start")
                        .map_err(|error| error.to_string())?,
                    end: row
                        .try_get("effective_end")
                        .map_err(|error| error.to_string())?,
                });
            }
        }
        Ok(candidates)
    }

    async fn protected_live_session_id(&self) -> Result<Option<i64>, String> {
        let rows = sqlx::query(
            "SELECT key,value FROM settings WHERE key IN \
             ('recording_consent','tracking_paused','tracking_paused_until','heartbeat_seconds',\
              'tracking_schedule_enabled','tracking_schedule_days',\
              'tracking_schedule_start_minute','tracking_schedule_end_minute')",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let mut consent = false;
        let mut paused = false;
        let mut paused_until = 0_i64;
        let mut heartbeat = 15_i64;
        let mut schedule_enabled = false;
        let mut schedule_days = "0,1,2,3,4".to_string();
        let mut schedule_start = "540".to_string();
        let mut schedule_end = "1020".to_string();
        for row in rows {
            let key: String = row.try_get("key").map_err(|error| error.to_string())?;
            let value: String = row.try_get("value").map_err(|error| error.to_string())?;
            match key.as_str() {
                "recording_consent" => consent = value == "1",
                "tracking_paused" => paused = value == "1",
                "tracking_paused_until" => paused_until = value.parse().unwrap_or(0),
                "heartbeat_seconds" => heartbeat = value.parse().unwrap_or(15),
                "tracking_schedule_enabled" => schedule_enabled = value == "1",
                "tracking_schedule_days" => schedule_days = value,
                "tracking_schedule_start_minute" => schedule_start = value,
                "tracking_schedule_end_minute" => schedule_end = value,
                _ => {}
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs() as i64;
        let local_now = Local::now();
        let schedule_allows = schedule_allows_local(
            schedule_enabled,
            &schedule_days,
            &schedule_start,
            &schedule_end,
            local_now.weekday().num_days_from_monday(),
            local_now.hour() * 60 + local_now.minute(),
        );
        if !consent || paused || paused_until > now || !schedule_allows {
            return Ok(None);
        }
        let row = sqlx::query(
            "SELECT id,end_ts FROM sessions WHERE source='live' \
             ORDER BY start_ts DESC,id DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let Some(row) = row else { return Ok(None) };
        let end: i64 = row.try_get("end_ts").map_err(|error| error.to_string())?;
        let freshness = 120_i64.max(heartbeat.clamp(5, 300) * 4);
        if end < now - freshness {
            return Ok(None);
        }
        row.try_get("id")
            .map(Some)
            .map_err(|error| error.to_string())
    }

    async fn max_session_id(&self) -> Result<i64, String> {
        let row = sqlx::query("SELECT COALESCE(MAX(id),0) AS max_id FROM sessions")
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        row.try_get("max_id").map_err(|error| error.to_string())
    }

    pub async fn preview_activity_delete(
        &self,
        request: &ActivityDeleteRequest,
    ) -> Result<ActivityDeletePreview, String> {
        let snapshot_max_id = self.max_session_id().await?;
        let protected = self.protected_live_session_id().await?;
        let candidates = self.activity_delete_candidates(request).await?;
        let mut count = 0_u64;
        let mut seconds = 0_i64;
        let mut earliest_start: Option<i64> = None;
        let mut latest_end: Option<i64> = None;
        let mut protected_count = 0_u64;
        for candidate in candidates {
            if candidate.id > snapshot_max_id {
                continue;
            }
            if Some(candidate.id) == protected {
                protected_count += 1;
                continue;
            }
            count += 1;
            seconds += (candidate.end - candidate.start).max(0);
            earliest_start =
                Some(earliest_start.map_or(candidate.start, |value| value.min(candidate.start)));
            latest_end = Some(latest_end.map_or(candidate.end, |value| value.max(candidate.end)));
        }
        Ok(ActivityDeletePreview {
            count,
            seconds,
            earliest_start,
            latest_end,
            protected_count,
            snapshot_max_id,
            protected_session_id: protected,
        })
    }

    pub async fn delete_activity(
        &self,
        request: &ActivityDeleteRequest,
    ) -> Result<ActivityDeleteResult, String> {
        self.ensure_writable_schema()?;
        let snapshot_max_id = request
            .snapshot_max_id
            .ok_or("Preview Activity deletion before confirming")?;
        let protected = self.protected_live_session_id().await?;
        let preview_protected = request.preview_protected_session_id;
        let candidates = self.activity_delete_candidates(request).await?;
        let mut protected_count = 0_u64;
        let ids = candidates
            .into_iter()
            .filter_map(|candidate| {
                if candidate.id > snapshot_max_id {
                    return None;
                }
                if Some(candidate.id) == protected || Some(candidate.id) == preview_protected {
                    protected_count += 1;
                    return None;
                }
                Some(candidate.id)
            })
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(ActivityDeleteResult {
                deleted_count: 0,
                protected_count,
            });
        }
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        let mut deleted_count = 0_u64;
        for chunk in ids.chunks(ID_CHUNK) {
            let placeholders = placeholders(chunk.len(), "?");
            let sql = format!("DELETE FROM sessions WHERE id IN ({placeholders})");
            let mut query = sqlx::query(&sql);
            for id in chunk {
                query = query.bind(id);
            }
            deleted_count += query
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?
                .rows_affected();
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        self.compact().await?;
        Ok(ActivityDeleteResult {
            deleted_count,
            protected_count,
        })
    }

    pub async fn list_tracking_exclusions(&self) -> Result<Vec<TrackingExclusion>, String> {
        let rows = sqlx::query(
            "SELECT kind,pattern,created_ts FROM tracking_exclusions ORDER BY kind,pattern",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        rows.into_iter()
            .map(|row| {
                Ok(TrackingExclusion {
                    kind: row.try_get("kind").map_err(|error| error.to_string())?,
                    pattern: row.try_get("pattern").map_err(|error| error.to_string())?,
                    created_ts: row
                        .try_get("created_ts")
                        .map_err(|error| error.to_string())?,
                })
            })
            .collect()
    }

    pub async fn preview_tracking_exclusion(
        &self,
        kind: &str,
        pattern: &str,
    ) -> Result<TrackingExclusionPreview, String> {
        let normalized = normalize_exclusion(kind, pattern)?;
        let predicate = match kind {
            "app" => "lower(s.process)=?",
            "website" => "lower(IFNULL(s.domain,''))=?",
            _ => return Err("Unsupported tracking exclusion kind".into()),
        };
        let sql = format!(
            "SELECT COUNT(*) AS n,COALESCE(SUM(MAX(0,COALESCE(c.corrected_end_ts,s.end_ts)- \
             COALESCE(c.corrected_start_ts,s.start_ts))),0) AS seconds \
             {CORRECTED_JOIN} WHERE {predicate}"
        );
        let row = sqlx::query(&sql)
            .bind(&normalized)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(TrackingExclusionPreview {
            count: row
                .try_get::<i64, _>("n")
                .map_err(|error| error.to_string())? as u64,
            seconds: row.try_get("seconds").map_err(|error| error.to_string())?,
            normalized_pattern: normalized,
        })
    }

    pub async fn add_tracking_exclusion(
        &self,
        kind: &str,
        pattern: &str,
        delete_history: bool,
    ) -> Result<TrackingExclusionResult, String> {
        self.ensure_writable_schema()?;
        let normalized = normalize_exclusion(kind, pattern)?;
        let now = unix_now()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO tracking_exclusions (kind,pattern,created_ts) VALUES (?,?,?) \
             ON CONFLICT(kind,pattern) DO NOTHING",
        )
        .bind(kind)
        .bind(&normalized)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
        let deleted_count = if delete_history {
            let sql = match kind {
                "app" => "DELETE FROM sessions WHERE lower(process)=?",
                "website" => "DELETE FROM sessions WHERE lower(IFNULL(domain,''))=?",
                _ => return Err("Unsupported tracking exclusion kind".into()),
            };
            sqlx::query(sql)
                .bind(&normalized)
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?
                .rows_affected()
        } else {
            0
        };
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        if deleted_count > 0 {
            self.compact().await?;
        }
        Ok(TrackingExclusionResult {
            normalized_pattern: normalized,
            deleted_count,
        })
    }

    pub async fn remove_tracking_exclusion(
        &self,
        kind: &str,
        pattern: &str,
    ) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        let normalized = normalize_exclusion(kind, pattern)?;
        sqlx::query("DELETE FROM tracking_exclusions WHERE kind=? AND pattern=?")
            .bind(kind)
            .bind(normalized)
            .execute(&self.pool)
            .await
            .map(|result| result.rows_affected())
            .map_err(|error| error.to_string())
    }

    pub async fn fetch_session_correction(
        &self,
        session_id: i64,
    ) -> Result<SessionCorrection, String> {
        let sql = format!(
            "SELECT s.id,s.start_ts,s.end_ts,s.process,s.title,s.domain,s.is_afk, \
             {EFFECTIVE_SPAN},c.category_id, \
             c.session_id IS NOT NULL AS is_corrected \
             {CORRECTED_JOIN} WHERE s.id=?"
        );
        let row = sqlx::query(&sql)
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Session no longer exists")?;
        let protected = self.protected_live_session_id().await?;
        let effective_start: i64 = row
            .try_get("effective_start")
            .map_err(|error| error.to_string())?;
        let effective_end: i64 = row
            .try_get("effective_end")
            .map_err(|error| error.to_string())?;
        // Mirrors the overlap test in correct_session, including that it does
        // not exclude AFK rows: a neighbour is anything occupying the clock.
        // Touching endpoints are legal, so these are the exact bounds rather
        // than one second inside them.
        let sql = format!(
            "SELECT (SELECT MAX(COALESCE(c.corrected_end_ts,s.end_ts)) \
               {CORRECTED_JOIN} \
               WHERE s.id<>?1 AND COALESCE(c.corrected_end_ts,s.end_ts)<=?2) AS earliest_start, \
             (SELECT MIN(COALESCE(c.corrected_start_ts,s.start_ts)) \
               {CORRECTED_JOIN} \
               WHERE s.id<>?1 AND COALESCE(c.corrected_start_ts,s.start_ts)>=?3) AS latest_end"
        );
        let bounds = sqlx::query(&sql)
            .bind(session_id)
            .bind(effective_start)
            .bind(effective_end)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(SessionCorrection {
            session_id,
            original_start: row.try_get("start_ts").map_err(|error| error.to_string())?,
            original_end: row.try_get("end_ts").map_err(|error| error.to_string())?,
            start: effective_start,
            end: effective_end,
            process: row.try_get("process").map_err(|error| error.to_string())?,
            title: row.try_get("title").map_err(|error| error.to_string())?,
            domain: row.try_get("domain").map_err(|error| error.to_string())?,
            category_id: row
                .try_get("category_id")
                .map_err(|error| error.to_string())?,
            is_afk: row
                .try_get::<i64, _>("is_afk")
                .map_err(|error| error.to_string())?
                != 0,
            is_live: protected == Some(session_id),
            is_corrected: row
                .try_get::<i64, _>("is_corrected")
                .map_err(|error| error.to_string())?
                != 0,
            earliest_start: bounds
                .try_get("earliest_start")
                .map_err(|error| error.to_string())?,
            latest_end: bounds
                .try_get("latest_end")
                .map_err(|error| error.to_string())?,
        })
    }

    pub async fn correct_session(
        &self,
        request: &SessionCorrectionRequest,
    ) -> Result<SessionCorrection, String> {
        self.ensure_writable_schema()?;
        if !request.start_sec.is_finite() || !request.end_sec.is_finite() {
            return Err("Session times must be finite".into());
        }
        let start = request.start_sec.floor() as i64;
        let end = request.end_sec.floor() as i64;
        if end <= start {
            return Err("Session end must be after its start".into());
        }
        if end - start > MAX_SESSION_SPAN_SEC {
            return Err("A corrected session cannot be longer than seven days".into());
        }
        if end > unix_now()? {
            return Err("A corrected session cannot end in the future".into());
        }
        let original = sqlx::query("SELECT start_ts,end_ts,is_afk FROM sessions WHERE id=?")
            .bind(request.session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Session no longer exists")?;
        if original
            .try_get::<i64, _>("is_afk")
            .map_err(|error| error.to_string())?
            != 0
        {
            return Err("AFK sessions cannot be edited".into());
        }
        if self.protected_live_session_id().await? == Some(request.session_id) {
            return Err("The current live session cannot be edited".into());
        }
        if let Some(category_id) = request.category_id {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories WHERE id=?")
                .bind(category_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
            if exists == 0 {
                return Err("The selected category no longer exists".into());
            }
        }
        let sql = format!("SELECT COUNT(*) {CORRECTED_JOIN} WHERE s.id<>? AND {OVERLAPS_WINDOW}");
        let overlaps: i64 = sqlx::query_scalar(&sql)
            .bind(request.session_id)
            .bind(start)
            .bind(end)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        if overlaps > 0 {
            return Err("Corrected times overlap another recorded session".into());
        }
        let original_start: i64 = original
            .try_get("start_ts")
            .map_err(|error| error.to_string())?;
        let original_end: i64 = original
            .try_get("end_ts")
            .map_err(|error| error.to_string())?;
        if start == original_start && end == original_end && request.category_id.is_none() {
            sqlx::query("DELETE FROM session_corrections WHERE session_id=?")
                .bind(request.session_id)
                .execute(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            let corrected_start = (start != original_start || end != original_end).then_some(start);
            let corrected_end = (start != original_start || end != original_end).then_some(end);
            sqlx::query(
                "INSERT INTO session_corrections \
                 (session_id,corrected_start_ts,corrected_end_ts,category_id,updated_ts) \
                 VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET \
                 corrected_start_ts=excluded.corrected_start_ts, \
                 corrected_end_ts=excluded.corrected_end_ts,category_id=excluded.category_id, \
                 updated_ts=excluded.updated_ts",
            )
            .bind(request.session_id)
            .bind(corrected_start)
            .bind(corrected_end)
            .bind(request.category_id)
            .bind(unix_now()?)
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        }
        self.fetch_session_correction(request.session_id).await
    }

    pub async fn reset_session_correction(&self, session_id: i64) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        if self.protected_live_session_id().await? == Some(session_id) {
            return Err("The current live session cannot be edited".into());
        }
        sqlx::query("DELETE FROM session_corrections WHERE session_id=?")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map(|result| result.rows_affected())
            .map_err(|error| error.to_string())
    }

    /// Applies one category to many sessions, or clears theirs.
    ///
    /// Recorded times are never touched, so an existing time correction on a
    /// reclassified session survives — which is why the upsert names only the
    /// two columns it owns instead of writing the whole row.
    pub async fn classify_sessions(
        &self,
        request: &SessionClassificationRequest,
    ) -> Result<SessionClassificationResult, String> {
        self.ensure_writable_schema()?;
        if request.session_ids.is_empty() {
            return Err("Select at least one session".into());
        }
        if request.session_ids.len() > 100_000 {
            return Err("Too many sessions selected at once".into());
        }
        if let Some(category_id) = request.category_id {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories WHERE id=?")
                .bind(category_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
            if exists == 0 {
                return Err("The selected category no longer exists".into());
            }
        }
        let mut unique = request.session_ids.iter().copied().collect::<HashSet<_>>();
        unique.retain(|id| *id > 0);
        let ids = unique.into_iter().collect::<Vec<_>>();
        let protected = self.protected_live_session_id().await?;

        // Reading the prior state first serves two purposes: it is the undo the
        // result carries, and it is what decides which sessions are actually
        // changing — a session already in the target category is not a change,
        // and counting it as one would make the confirmation a lie.
        let mut skipped_count = 0_u64;
        let mut previous = Vec::new();
        let mut writable = Vec::new();
        for chunk in ids.chunks(ID_CHUNK) {
            let placeholders = placeholders(chunk.len(), "?");
            let sql = format!(
                "SELECT s.id,s.is_afk,c.category_id,c.corrected_start_ts {CORRECTED_JOIN} \
                 WHERE s.id IN ({placeholders})"
            );
            let mut query = sqlx::query(&sql);
            for id in chunk {
                query = query.bind(id);
            }
            for row in query
                .fetch_all(&self.pool)
                .await
                .map_err(|error| error.to_string())?
            {
                let id: i64 = row.try_get("id").map_err(|error| error.to_string())?;
                let is_afk: i64 = row.try_get("is_afk").map_err(|error| error.to_string())?;
                if is_afk != 0 || Some(id) == protected {
                    skipped_count += 1;
                    continue;
                }
                let category_id: Option<i64> = row
                    .try_get("category_id")
                    .map_err(|error| error.to_string())?;
                if category_id == request.category_id {
                    continue;
                }
                let corrected_start: Option<i64> = row
                    .try_get("corrected_start_ts")
                    .map_err(|error| error.to_string())?;
                previous.push(SessionClassification {
                    session_id: id,
                    category_id,
                });
                writable.push((id, corrected_start.is_some()));
            }
        }
        if writable.is_empty() {
            return Ok(SessionClassificationResult {
                changed_count: 0,
                skipped_count,
                previous,
            });
        }

        let now = unix_now()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        let mut changed_count = 0_u64;
        if let Some(category_id) = request.category_id {
            for chunk in writable.chunks(ID_CHUNK) {
                let values = placeholders(chunk.len(), "(?,NULL,NULL,?,?)");
                // Only the two columns this call owns. `excluded` would carry
                // the NULL times above into an existing row and silently drop a
                // correction someone made to the clock.
                let sql = format!(
                    "INSERT INTO session_corrections \
                     (session_id,corrected_start_ts,corrected_end_ts,category_id,updated_ts) \
                     VALUES {values} ON CONFLICT(session_id) DO UPDATE SET \
                     category_id=excluded.category_id,updated_ts=excluded.updated_ts"
                );
                let mut query = sqlx::query(&sql);
                for (id, _) in chunk {
                    query = query.bind(id).bind(category_id).bind(now);
                }
                changed_count += query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected();
            }
        } else {
            // Clearing leaves a row behind only where it still carries a time
            // correction. An override-only row with no category is what
            // correct_session deletes rather than store, and an empty row here
            // would report a session as corrected forever after.
            let (timed, bare): (Vec<_>, Vec<_>) =
                writable.iter().partition(|(_, has_times)| *has_times);
            for chunk in timed.chunks(ID_CHUNK) {
                let placeholders = placeholders(chunk.len(), "?");
                let sql = format!(
                    "UPDATE session_corrections SET category_id=NULL,updated_ts=? \
                     WHERE session_id IN ({placeholders})"
                );
                let mut query = sqlx::query(&sql).bind(now);
                for (id, _) in chunk {
                    query = query.bind(id);
                }
                changed_count += query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected();
            }
            for chunk in bare.chunks(ID_CHUNK) {
                let placeholders = placeholders(chunk.len(), "?");
                let sql =
                    format!("DELETE FROM session_corrections WHERE session_id IN ({placeholders})");
                let mut query = sqlx::query(&sql);
                for (id, _) in chunk {
                    query = query.bind(id);
                }
                changed_count += query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected();
            }
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        Ok(SessionClassificationResult {
            changed_count,
            skipped_count,
            previous,
        })
    }

    pub async fn delete_history_before(&self, cutoff_sec: f64) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        if !cutoff_sec.is_finite() {
            return Err("Invalid history cutoff".into());
        }
        let sql = format!(
            "DELETE FROM sessions WHERE id IN (SELECT s.id {CORRECTED_JOIN} \
             WHERE COALESCE(c.corrected_end_ts,s.end_ts) < ?)"
        );
        let result = sqlx::query(&sql)
            .bind(cutoff_sec.floor() as i64)
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        if result.rows_affected() > 0 {
            self.compact().await?;
        }
        Ok(result.rows_affected())
    }

    pub fn backups_dir(&self) -> Result<PathBuf, String> {
        let parent = self.path.parent().ok_or("database path has no parent")?;
        let directory = parent.join("Backups");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Ok(directory)
    }

    async fn backup_named(&self, prefix: &str) -> Result<String, String> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();
        let target = self.backups_dir()?.join(format!("{prefix}_{stamp}.db"));
        let escaped = target.to_string_lossy().replace("'", "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    }

    pub async fn backup(&self) -> Result<String, String> {
        self.backup_named("backup_manual").await
    }

    async fn read_restore_settings(
        path: &Path,
        integrity: bool,
    ) -> Result<(i64, bool, bool), String> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| format!("Could not open backup: {error}"))?;
        let result = async {
            let settings_exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            )
            .fetch_one(&pool)
            .await
            .map_err(|error| error.to_string())?;
            if settings_exists == 0 {
                return Err("This file is not a versioned Time database".to_owned());
            }
            let raw_version = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='schema_version'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "This backup has no schema version".to_owned())?;
            let schema_version = raw_version
                .parse::<i64>()
                .map_err(|_| "This backup has an invalid schema version".to_owned())?;
            if schema_version < 1 {
                return Err("This backup predates supported Time databases".to_owned());
            }
            if integrity {
                let checks: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
                    .fetch_all(&pool)
                    .await
                    .map_err(|error| error.to_string())?;
                if checks.as_slice() != ["ok"] {
                    return Err(format!(
                        "Backup integrity check failed: {}",
                        checks.join("; ")
                    ));
                }
                let foreign_key_errors: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                        .fetch_one(&pool)
                        .await
                        .map_err(|error| error.to_string())?;
                if foreign_key_errors > 0 {
                    return Err(format!(
                        "Backup has {foreign_key_errors} foreign-key integrity errors"
                    ));
                }
            }
            let recording_consent = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='recording_consent'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string())?
            .as_deref()
                == Some("1");
            let launch_at_login = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='launch_at_login'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string())?
            .as_deref()
                == Some("1");
            Ok((schema_version, recording_consent, launch_at_login))
        }
        .await;
        pool.close().await;
        result
    }

    fn backup_kind(name: &str) -> String {
        if name.starts_with("backup_manual_") {
            "Manual".to_owned()
        } else if name.starts_with("backup_schema") {
            "Before update".to_owned()
        } else if name.starts_with("backup_pre_restore_") {
            "Before restore".to_owned()
        } else {
            "Backup".to_owned()
        }
    }

    async fn inspect_backup_path(
        path: PathBuf,
        legacy_location: bool,
    ) -> Result<DatabaseBackup, String> {
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Backup path is not a file".into());
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("Backup filename is not valid Unicode")?
            .to_owned();
        let modified_sec = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let inspected = Self::read_restore_settings(&path, false).await;
        let (schema_version, compatible, issue) = match inspected {
            Ok((version, _, _)) if version > SCHEMA_VERSION => (
                Some(version),
                false,
                Some(format!(
                    "Created by a newer Time database (schema {version}; this version supports {SCHEMA_VERSION})"
                )),
            ),
            Ok((version, _, _)) => (Some(version), true, None),
            Err(error) => (None, false, Some(error)),
        };
        Ok(DatabaseBackup {
            path: path.to_string_lossy().into_owned(),
            name: name.clone(),
            kind: Self::backup_kind(&name),
            modified_sec,
            bytes: metadata.len(),
            schema_version,
            compatible,
            issue,
            legacy_location,
        })
    }

    pub async fn inspect_backup(&self, path: PathBuf) -> Result<DatabaseBackup, String> {
        let backup_dir = self.backups_dir()?;
        let legacy_location = path.parent() != Some(backup_dir.as_path());
        Self::inspect_backup_path(path, legacy_location).await
    }

    pub async fn list_backups(&self) -> Result<Vec<DatabaseBackup>, String> {
        let parent = self.path.parent().ok_or("database path has no parent")?;
        let backup_dir = self.backups_dir()?;
        let mut paths = Vec::new();
        for (directory, legacy) in [(backup_dir, false), (parent.to_path_buf(), true)] {
            let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
            for entry in entries {
                let path = entry.map_err(|error| error.to_string())?.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if name.starts_with("backup_")
                    && path.extension().and_then(|value| value.to_str()) == Some("db")
                {
                    paths.push((path, legacy));
                }
            }
        }
        let mut backups = Vec::with_capacity(paths.len());
        for (path, legacy) in paths {
            if let Ok(backup) = Self::inspect_backup_path(path, legacy).await {
                backups.push(backup);
            }
        }
        backups.sort_by(|left, right| right.modified_sec.cmp(&left.modified_sec));
        Ok(backups)
    }

    /// A file beside the database. The restore set all lives here, and the
    /// failure mode this guards — a database path with no parent — is the same
    /// for every one of them.
    fn sibling(database_path: &Path, name: &str) -> Result<PathBuf, String> {
        Ok(database_path
            .parent()
            .ok_or("database path has no parent")?
            .join(name))
    }

    fn pending_database_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_pending.db")
    }

    fn pending_marker_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_pending.json")
    }

    fn restore_notice_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_notice.json")
    }

    fn rollback_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_previous.db")
    }

    /// Where a failed restore parks the database it could not replace. Named
    /// alongside the rest of the restore set rather than inlined at its one
    /// call site, so the whole set reads as a list.
    fn failed_restore_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_failed.db")
    }

    fn remove_if_exists(path: &Path) -> Result<(), String> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn remove_database_sidecars(path: &Path) -> Result<(), String> {
        Self::remove_if_exists(&path.with_extension("db-wal"))?;
        Self::remove_if_exists(&path.with_extension("db-shm"))
    }

    /// Copy a database and fold any write-ahead log into the copy.
    ///
    /// Every restore validates through a read-only connection, and a read-only
    /// connection cannot build the shared-memory index a `-wal` needs: it reads
    /// the main file alone. A backup carrying a log — one copied out of a
    /// running Time, say — therefore looked like a database with no `settings`
    /// table and was rejected as "not a versioned Time database". Copying only
    /// the main file had the worse failure: whatever the log still held was
    /// dropped, silently, from the database being restored.
    ///
    /// Stage both, then checkpoint the copy, so the thing validated is exactly
    /// the thing restored. The original is never written to.
    async fn stage_consolidated_copy(source: &Path, destination: &Path) -> Result<(), String> {
        Self::remove_if_exists(destination)?;
        Self::remove_database_sidecars(destination)?;
        fs::copy(source, destination).map_err(|error| error.to_string())?;
        let source_log = source.with_extension("db-wal");
        if source_log.is_file() {
            fs::copy(&source_log, destination.with_extension("db-wal"))
                .map_err(|error| error.to_string())?;
        }

        let options = SqliteConnectOptions::new()
            .filename(destination)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| format!("Could not open backup: {error}"))?;
        let checkpoint = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await;
        pool.close().await;
        checkpoint.map_err(|error| error.to_string())?;
        Self::remove_database_sidecars(destination)
    }

    fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        Self::remove_if_exists(path)?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    }

    pub async fn prepare_restore(&self, source: PathBuf) -> Result<PendingRestore, String> {
        let source = fs::canonicalize(&source).map_err(|error| error.to_string())?;
        let live = fs::canonicalize(&self.path).map_err(|error| error.to_string())?;
        if source == live {
            return Err("Choose a backup, not the live Time database".into());
        }
        let pending_path = Self::pending_database_path(&self.path)?;
        let marker_path = Self::pending_marker_path(&self.path)?;
        // Must end in `.db`: SQLite names a log after the whole filename, and
        // the sidecar helpers derive it by replacing the last extension. A
        // `.tmp` staging name made those two disagree, so the copied log was
        // never replayed and its real one was still open at the rename.
        let temporary_path = pending_path.with_file_name("restore_staging.db");

        // Stage before validating. Reading the source and then copying it left a
        // window where the file could change in between; validating the staged
        // copy closes it, and the copy is what actually gets restored.
        Self::stage_consolidated_copy(&source, &temporary_path).await?;
        let (schema_version, recording_consent, launch_at_login) =
            match Self::read_restore_settings(&temporary_path, true).await {
                Ok(settings) => settings,
                Err(error) => {
                    Self::remove_if_exists(&temporary_path)?;
                    return Err(error);
                }
            };
        if schema_version > SCHEMA_VERSION {
            Self::remove_if_exists(&temporary_path)?;
            return Err(format!(
                "This backup uses schema {schema_version}; this Time version supports {SCHEMA_VERSION}"
            ));
        }
        let safety_backup_path = self.backup_named("backup_pre_restore").await?;
        Self::remove_if_exists(&pending_path)?;
        fs::rename(&temporary_path, &pending_path).map_err(|error| error.to_string())?;
        let pending = PendingRestore {
            source_name: source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("selected backup")
                .to_owned(),
            safety_backup_path,
            schema_version,
            recording_consent,
            launch_at_login,
        };
        if let Err(error) = Self::write_json_atomic(&marker_path, &pending) {
            let _ = Self::remove_if_exists(&pending_path);
            return Err(error);
        }
        Ok(pending)
    }

    pub async fn recording_consent(&self) -> Result<bool, String> {
        Ok(sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key='recording_consent'",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| error.to_string())?
        .as_deref()
            == Some("1"))
    }

    pub async fn refresh_pending_safety_backup(
        &self,
        pending: &mut PendingRestore,
    ) -> Result<(), String> {
        let previous = PathBuf::from(&pending.safety_backup_path);
        let current = self.backup_named("backup_pre_restore").await?;
        pending.safety_backup_path = current;
        Self::write_json_atomic(&Self::pending_marker_path(&self.path)?, pending)?;
        // The first snapshot protected the validation/staging phase. Once the
        // stopped-tracker snapshot is durably named in the marker, only that
        // later copy is needed.
        let _ = Self::remove_if_exists(&previous);
        Ok(())
    }

    pub fn cancel_pending_restore(&self) -> Result<(), String> {
        Self::remove_if_exists(&Self::pending_database_path(&self.path)?)?;
        Self::remove_if_exists(&Self::pending_marker_path(&self.path)?)
    }

    pub async fn begin_pending_restore(
        database_path: &Path,
    ) -> Result<Option<RestoreSwap>, String> {
        let marker_path = Self::pending_marker_path(database_path)?;
        if !marker_path.exists() {
            return Ok(None);
        }
        let pending_path = Self::pending_database_path(database_path)?;
        let rollback_path = Self::rollback_path(database_path)?;
        let pending: PendingRestore =
            serde_json::from_slice(&fs::read(&marker_path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Could not read pending restore: {error}"))?;

        // A process exit between the two renames leaves the old database in the
        // rollback slot. Put it back before retrying the staged swap.
        if rollback_path.exists() && !database_path.exists() && pending_path.exists() {
            fs::rename(&rollback_path, database_path).map_err(|error| error.to_string())?;
        }
        if rollback_path.exists() && database_path.exists() && !pending_path.exists() {
            let restored = Self::read_restore_settings(database_path, true).await?;
            if restored.0 != pending.schema_version {
                return Err("Restored database does not match its pending marker".into());
            }
            return Ok(Some(RestoreSwap {
                pending,
                rollback_path,
                marker_path,
                database_path: database_path.to_path_buf(),
            }));
        }
        if rollback_path.exists() {
            return Err("A previous database restore did not finish cleanly".into());
        }
        let staged = Self::read_restore_settings(&pending_path, true).await?;
        if staged.0 != pending.schema_version {
            return Err("Staged database does not match its pending marker".into());
        }
        Self::remove_database_sidecars(database_path)?;
        fs::rename(database_path, &rollback_path).map_err(|error| error.to_string())?;
        if let Err(error) = fs::rename(&pending_path, database_path) {
            // Putting the original back is the only thing between a failed swap
            // and an empty database opened over the user's history. Discarding
            // that failure left no database in place, and the caller could not
            // tell the difference, so say it plainly instead.
            if let Err(rollback) = fs::rename(&rollback_path, database_path) {
                return Err(format!(
                    "The restore could not be applied ({error}) and the previous database could \
                     not be put back ({rollback}). It is saved as {}",
                    rollback_path.display()
                ));
            }
            return Err(error.to_string());
        }
        Ok(Some(RestoreSwap {
            pending,
            rollback_path,
            marker_path,
            database_path: database_path.to_path_buf(),
        }))
    }

    pub fn discard_pending_restore(database_path: &Path, message: String) -> Result<(), String> {
        Self::remove_if_exists(&Self::pending_database_path(database_path)?)?;
        Self::remove_if_exists(&Self::pending_marker_path(database_path)?)?;
        Self::write_restore_notice(database_path, RestoreNotice { ok: false, message })
    }

    pub fn write_restore_notice(database_path: &Path, notice: RestoreNotice) -> Result<(), String> {
        Self::write_json_atomic(&Self::restore_notice_path(database_path)?, &notice)
    }

    pub fn take_restore_notice(database_path: &Path) -> Result<Option<RestoreNotice>, String> {
        let path = Self::restore_notice_path(database_path)?;
        if !path.exists() {
            return Ok(None);
        }
        let notice = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        Self::remove_if_exists(&path)?;
        Ok(Some(notice))
    }

    pub async fn erase_history(&self) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        let result = sqlx::query("DELETE FROM sessions")
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        // secure_delete overwrites deleted cells; checkpoint and compact so old
        // title text is not left recoverable in the WAL or free database pages.
        self.compact().await?;
        Ok(result.rows_affected())
    }

    async fn compact(&self) -> Result<(), String> {
        self.ensure_writable_schema()?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query("VACUUM")
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Every write path must call this first. Reads stay available on a
    /// schema this release cannot write (see `open`).
    fn ensure_writable_schema(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "Database schema {} is not writable by this Time release ({SCHEMA_VERSION})",
                self.schema_version
            ));
        }
        Ok(())
    }
}

impl RestoreSwap {
    pub fn commit(self) -> Result<(), String> {
        TimeDatabase::remove_if_exists(&self.marker_path)?;
        TimeDatabase::remove_if_exists(&self.rollback_path)
    }

    pub fn rollback(self) -> Result<(), String> {
        TimeDatabase::remove_database_sidecars(&self.database_path)?;
        let failed_path = TimeDatabase::failed_restore_path(&self.database_path)?;
        TimeDatabase::remove_if_exists(&failed_path)?;
        fs::rename(&self.database_path, &failed_path).map_err(|error| error.to_string())?;
        if let Err(error) = fs::rename(&self.rollback_path, &self.database_path) {
            let _ = fs::rename(&failed_path, &self.database_path);
            return Err(error.to_string());
        }
        TimeDatabase::remove_if_exists(&failed_path)?;
        TimeDatabase::remove_if_exists(&self.marker_path)?;
        TimeDatabase::remove_if_exists(&TimeDatabase::pending_database_path(&self.database_path)?)
    }
}

fn unix_now() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|error| error.to_string())
}

fn normalize_exclusion(kind: &str, raw: &str) -> Result<String, String> {
    let mut normalized = raw.trim().to_ascii_lowercase();
    match kind {
        "app" => {
            if normalized.is_empty()
                || normalized.len() > 255
                || normalized.contains('/')
                || normalized.contains('\\')
            {
                return Err("Enter an executable name such as code.exe".into());
            }
            // Exclusions match stored process names exactly, so a bare "code"
            // would silently never fire. The caller shows the normalized
            // pattern back, so the added suffix is visible rather than magic.
            if !normalized.contains('.') {
                normalized.push_str(".exe");
            }
        }
        "website" => {
            if let Some(scheme) = normalized.find("://") {
                normalized = normalized[(scheme + 3)..].to_owned();
            }
            normalized = normalized
                .split(['/', '?', '#'])
                .next()
                .unwrap_or("")
                .rsplit('@')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
                .trim_matches('.')
                .to_owned();
            if let Some(stripped) = normalized.strip_prefix("www.") {
                normalized = stripped.to_owned();
            }
            if normalized.is_empty()
                || normalized.len() > 253
                || normalized.chars().any(char::is_whitespace)
                || !normalized.contains('.')
            {
                return Err("Enter a website such as example.com".into());
            }
        }
        _ => return Err("Unsupported tracking exclusion kind".into()),
    }
    Ok(normalized)
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: JsonValue,
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, String> {
    Ok(match value {
        JsonValue::Null => query.bind(Option::<String>::None),
        JsonValue::String(value) => query.bind(value),
        JsonValue::Bool(value) => query.bind(value),
        JsonValue::Number(value) => {
            if let Some(integer) = value.as_i64() {
                query.bind(integer)
            } else if let Some(float) = value.as_f64() {
                query.bind(float)
            } else {
                return Err("Unsupported numeric SQL parameter".into());
            }
        }
        JsonValue::Array(_) | JsonValue::Object(_) => {
            return Err("Structured JSON cannot be used as a SQL parameter".into());
        }
    })
}

fn sqlite_value_to_json(raw: sqlx::sqlite::SqliteValueRef<'_>) -> Result<JsonValue, String> {
    if raw.is_null() {
        return Ok(JsonValue::Null);
    }
    match raw.type_info().name() {
        "TEXT" => raw
            .to_owned()
            .try_decode::<String>()
            .map(JsonValue::String)
            .map_err(|error| error.to_string()),
        "REAL" => raw
            .to_owned()
            .try_decode::<f64>()
            .map(JsonValue::from)
            .map_err(|error| error.to_string()),
        "INTEGER" | "NUMERIC" | "BOOLEAN" => raw
            .to_owned()
            .try_decode::<i64>()
            .map(JsonValue::from)
            .map_err(|error| error.to_string()),
        "BLOB" => raw
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|bytes| JsonValue::Array(bytes.into_iter().map(JsonValue::from).collect()))
            .map_err(|error| error.to_string()),
        other => Err(format!("Unsupported SQLite result type: {other}")),
    }
}

pub fn database_path(base: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TIME_DB_PATH") {
        return PathBuf::from(path);
    }
    base.join("Time").join("time_log.db")
}

#[cfg(test)]
mod tests {
    use super::{
        schedule_allows_local, ActivityDeleteRequest, SessionClassificationRequest,
        SessionCorrectionRequest, TimeDatabase, BOOTSTRAP_SQL, SCHEMA_VERSION,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory no previous run has touched.
    ///
    /// Sharing one path means deleting the last run's files first, and on
    /// Windows a handle that has not finished closing turns that into a sharing
    /// violation — or leaves the directory in a delete-pending state where a
    /// file written afterwards silently disappears. Both were live flakes here.
    fn scratch_root(name: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let unique = NEXT.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("{name}-{stamp}-{unique}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn scratch_database(name: &str) -> PathBuf {
        scratch_root(name).join("time_log.db")
    }

    #[test]
    fn rejects_dangerous_or_multi_statement_sql() {
        for query in [
            "DROP TABLE sessions",
            "SELECT * FROM sessions; DELETE FROM sessions",
            "SELECT * FROM pragma_table_info('sessions')",
            "SELECT 1 -- comment",
        ] {
            assert!(TimeDatabase::validate_sql(query, &["SELECT"]).is_err());
        }
    }

    #[test]
    fn restricts_webview_mutation_targets() {
        assert!(TimeDatabase::validate_mutation_target(
            "INSERT INTO settings (key,value) VALUES ($1,$2)"
        )
        .is_ok());
        assert!(
            TimeDatabase::validate_mutation_target("DELETE FROM sessions WHERE id=$1").is_err()
        );
        assert!(
            TimeDatabase::validate_mutation_target("UPDATE rules SET pattern=$1 WHERE id=$2")
                .is_ok()
        );
        assert!(TimeDatabase::validate_mutation_target("UPDATE settings SET value='1'").is_err());
        assert!(TimeDatabase::validate_mutation_target("DELETE FROM settings").is_err());
    }

    #[test]
    fn exclusions_are_normalized_and_can_atomically_delete_history() {
        let path = scratch_database("database-exclusion-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,domain) VALUES \
                 (1,10,40,'chrome.exe','example.com'),(2,40,70,'code.exe',NULL)",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            let preview = database
                .preview_tracking_exclusion("website", "https://www.Example.com/path")
                .await
                .unwrap();
            assert_eq!(
                (
                    preview.normalized_pattern.as_str(),
                    preview.count,
                    preview.seconds
                ),
                ("example.com", 1, 30)
            );
            let result = database
                .add_tracking_exclusion("website", "https://www.Example.com/path", true)
                .await
                .unwrap();
            assert_eq!(result.deleted_count, 1);
            assert_eq!(database.list_tracking_exclusions().await.unwrap().len(), 1);
            let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
                .fetch_all(&database.pool)
                .await
                .unwrap();
            assert_eq!(remaining, vec![2]);
            database
                .add_tracking_exclusion("app", "CODE.EXE", false)
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
                    .fetch_one(&database.pool)
                    .await
                    .unwrap(),
                1
            );
        });
    }

    #[test]
    fn app_exclusions_supply_the_extension_sessions_are_stored_with() {
        assert_eq!(
            super::normalize_exclusion("app", " Code ").unwrap(),
            "code.exe"
        );
        assert_eq!(
            super::normalize_exclusion("app", "CODE.EXE").unwrap(),
            "code.exe"
        );
        // A dotted name is already specific enough to match on its own.
        assert_eq!(
            super::normalize_exclusion("app", "vim.bat").unwrap(),
            "vim.bat"
        );
        assert!(super::normalize_exclusion("app", "C:\\apps\\code.exe").is_err());
    }

    #[test]
    fn corrections_overlay_raw_sessions_and_validate_timeline_rules() {
        let path = scratch_database("database-correction-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            let now = super::unix_now().unwrap();
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,is_afk) VALUES \
                 (1,?,?, 'code.exe',0),(2,?,?,'other.exe',0),(3,?,?,'afk',1)",
            )
            .bind(now - 300)
            .bind(now - 250)
            .bind(now - 200)
            .bind(now - 150)
            .bind(now - 100)
            .bind(now - 50)
            .execute(&database.pool)
            .await
            .unwrap();
            let category_id: i64 =
                sqlx::query_scalar("SELECT id FROM categories ORDER BY id LIMIT 1")
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            let corrected = database
                .correct_session(&SessionCorrectionRequest {
                    session_id: 1,
                    start_sec: (now - 290) as f64,
                    end_sec: (now - 240) as f64,
                    category_id: Some(category_id),
                })
                .await
                .unwrap();
            assert_eq!(
                (corrected.start, corrected.end, corrected.category_id),
                (now - 290, now - 240, Some(category_id))
            );
            let raw: (i64, i64) = sqlx::query_as("SELECT start_ts,end_ts FROM sessions WHERE id=1")
                .fetch_one(&database.pool)
                .await
                .unwrap();
            assert_eq!(raw, (now - 300, now - 250));
            let columns = database
                .fetch_sessions((now - 400) as f64, now as f64, (now - 500) as f64)
                .await
                .unwrap();
            assert_eq!(columns.starts[0], now - 290);
            assert_eq!(columns.category_override_ids[0], Some(category_id));
            assert!(columns.is_corrected[0]);
            let overlap = database
                .correct_session(&SessionCorrectionRequest {
                    session_id: 1,
                    start_sec: (now - 220) as f64,
                    end_sec: (now - 180) as f64,
                    category_id: None,
                })
                .await;
            assert!(overlap.unwrap_err().contains("overlap"));
            let afk = database
                .correct_session(&SessionCorrectionRequest {
                    session_id: 3,
                    start_sec: (now - 100) as f64,
                    end_sec: (now - 50) as f64,
                    category_id: None,
                })
                .await;
            assert!(afk.unwrap_err().contains("AFK"));
            assert_eq!(database.reset_session_correction(1).await.unwrap(), 1);
            assert!(
                !database
                    .fetch_session_correction(1)
                    .await
                    .unwrap()
                    .is_corrected
            );
        });
    }

    #[test]
    fn bulk_classification_spares_recorded_times_afk_rows_and_unchanged_sessions() {
        let path = scratch_database("database-classify-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            let now = super::unix_now().unwrap();
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,is_afk) VALUES \
                 (1,?,?,'code.exe',0),(2,?,?,'code.exe',0),(3,?,?,'afk',1)",
            )
            .bind(now - 300)
            .bind(now - 250)
            .bind(now - 200)
            .bind(now - 150)
            .bind(now - 100)
            .bind(now - 50)
            .execute(&database.pool)
            .await
            .unwrap();
            let categories: Vec<i64> =
                sqlx::query_scalar("SELECT id FROM categories ORDER BY id LIMIT 2")
                    .fetch_all(&database.pool)
                    .await
                    .unwrap();
            let (first, second) = (categories[0], categories[1]);

            // Session 1 carries a time correction the reclassification must not
            // disturb; session 3 is AFK and can only ever be skipped.
            database
                .correct_session(&SessionCorrectionRequest {
                    session_id: 1,
                    start_sec: (now - 290) as f64,
                    end_sec: (now - 260) as f64,
                    category_id: None,
                })
                .await
                .unwrap();
            let applied = database
                .classify_sessions(&SessionClassificationRequest {
                    session_ids: vec![1, 2, 3],
                    category_id: Some(first),
                })
                .await
                .unwrap();
            assert_eq!((applied.changed_count, applied.skipped_count), (2, 1));
            assert_eq!(applied.previous.len(), 2);
            let corrected = database.fetch_session_correction(1).await.unwrap();
            assert_eq!(corrected.category_id, Some(first));
            assert_eq!((corrected.start, corrected.end), (now - 290, now - 260));

            // Only what actually moves is reported: session 1 is already there.
            let partial = database
                .classify_sessions(&SessionClassificationRequest {
                    session_ids: vec![1, 2],
                    category_id: Some(first),
                })
                .await
                .unwrap();
            assert_eq!(partial.changed_count, 0);
            assert!(partial.previous.is_empty());

            // Undo restores each session's own prior value, not one shared one.
            database
                .classify_sessions(&SessionClassificationRequest {
                    session_ids: vec![2],
                    category_id: Some(second),
                })
                .await
                .unwrap();
            for entry in applied.previous {
                database
                    .classify_sessions(&SessionClassificationRequest {
                        session_ids: vec![entry.session_id],
                        category_id: entry.category_id,
                    })
                    .await
                    .unwrap();
            }
            let restored = database.fetch_session_correction(1).await.unwrap();
            assert_eq!(restored.category_id, None);
            // The time correction outlives a cleared category; session 2 had
            // nothing else to keep, so its row goes rather than sitting empty
            // and reporting the session as corrected forever.
            assert_eq!((restored.start, restored.end), (now - 290, now - 260));
            assert!(restored.is_corrected);
            assert!(
                !database
                    .fetch_session_correction(2)
                    .await
                    .unwrap()
                    .is_corrected
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM session_corrections WHERE session_id=2"
                )
                .fetch_one(&database.pool)
                .await
                .unwrap(),
                0
            );

            let empty = database
                .classify_sessions(&SessionClassificationRequest {
                    session_ids: vec![],
                    category_id: Some(first),
                })
                .await;
            assert!(empty.unwrap_err().contains("at least one"));
            let missing = database
                .classify_sessions(&SessionClassificationRequest {
                    session_ids: vec![2],
                    category_id: Some(9_999),
                })
                .await;
            assert!(missing.unwrap_err().contains("no longer exists"));
        });
    }

    #[test]
    fn session_windows_follow_corrected_spans_not_raw_ones() {
        // fetch_sessions filters the uncorrected rows on the raw columns so the
        // start_ts index can drive them, and the corrected rows on their
        // effective spans. A correction that moves a session across a window
        // boundary is what tells those two branches apart: filtering everything
        // on raw columns would place session 1 in the wrong window, and
        // filtering everything through COALESCE would give up the index.
        let path = scratch_database("database-corrected-window-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            let now = super::unix_now().unwrap();
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,is_afk) VALUES \
                 (1,?,?,'moved.exe',0),(2,?,?,'stayed.exe',0)",
            )
            .bind(now - 10_000)
            .bind(now - 9_900)
            .bind(now - 500)
            .bind(now - 400)
            .execute(&database.pool)
            .await
            .unwrap();
            // Drag session 1 forward, out of its raw window and into session 2's.
            database
                .correct_session(&SessionCorrectionRequest {
                    session_id: 1,
                    start_sec: (now - 300) as f64,
                    end_sec: (now - 200) as f64,
                    category_id: None,
                })
                .await
                .unwrap();

            let recent = database
                .fetch_sessions((now - 600) as f64, now as f64, (now - 600 - 604_800) as f64)
                .await
                .unwrap();
            assert_eq!(recent.ids, vec![2, 1], "ordered by effective start");
            assert_eq!(recent.starts, vec![now - 500, now - 300]);
            assert_eq!(recent.is_corrected, vec![false, true]);

            // Its raw span is now empty: the correction moved it out entirely.
            let raw_window = database
                .fetch_sessions(
                    (now - 10_100) as f64,
                    (now - 9_800) as f64,
                    (now - 10_100 - 604_800) as f64,
                )
                .await
                .unwrap();
            assert!(
                raw_window.ids.is_empty(),
                "a corrected session must not answer for where its raw row sat",
            );
        });
    }

    #[test]
    fn bootstrap_stamps_the_schema_version_it_creates() {
        // The version lives twice in this file — once as the constant open()
        // enforces, once as a literal in the SQL that seeds a fresh database.
        // Bumping one and not the other makes every new database unopenable by
        // the code that just created it.
        let seeded = format!("('schema_version','{SCHEMA_VERSION}')");
        assert!(
            BOOTSTRAP_SQL.contains(&seeded),
            "BOOTSTRAP_SQL must seed schema_version {SCHEMA_VERSION}",
        );
    }

    /// A backup copied out of a running Time keeps its write-ahead log, and the
    /// rows it holds are not in the main file yet. Restore validates through a
    /// read-only connection, which cannot replay a log, so such a backup was
    /// rejected as unversioned — and when it was copied, the log was left
    /// behind and its rows vanished from the restored database.
    #[test]
    fn a_backup_carrying_a_write_ahead_log_restores_everything_it_holds() {
        let root = scratch_root("database-restore-wal-test");
        let live = root.join("time_log.db");
        let backup = root.join("copied-while-running.db");

        let origin = root.join("still-running.db");
        tauri::async_runtime::block_on(async {
            let source = TimeDatabase::open(origin.clone()).await.unwrap();
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (7,70,80,'kept.exe')",
            )
            .execute(&source.pool)
            .await
            .unwrap();
            // Copy while the database is still open, which is what taking a
            // backup out from under a running tracker actually produces: the
            // rows live in the log, not yet in the main file.
            std::fs::copy(&origin, &backup).unwrap();
            std::fs::copy(
                origin.with_extension("db-wal"),
                backup.with_extension("db-wal"),
            )
            .unwrap();
            source.close().await;
        });
        assert!(
            backup.with_extension("db-wal").is_file(),
            "the fixture must leave a write-ahead log for this to test anything",
        );

        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(live.clone()).await.unwrap();
            database.prepare_restore(backup.clone()).await.unwrap();
            database.close().await;

            let swap = TimeDatabase::begin_pending_restore(&live)
                .await
                .unwrap()
                .unwrap();
            swap.commit().unwrap();

            let restored = TimeDatabase::open(live.clone()).await.unwrap();
            let processes: Vec<String> =
                sqlx::query_scalar("SELECT process FROM sessions ORDER BY id")
                    .fetch_all(&restored.pool)
                    .await
                    .unwrap();
            assert_eq!(processes, ["kept.exe"]);
            restored.close().await;
        });
    }

    #[test]
    fn backup_folder_and_staged_restore_preserve_a_rollback_until_reopen() {
        let root = scratch_root("database-restore-test");
        let path = root.join("time_log.db");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (1,10,20,'code.exe')",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            let backup_path = PathBuf::from(database.backup().await.unwrap());
            assert_eq!(
                backup_path.parent().unwrap().file_name().unwrap(),
                "Backups"
            );
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (2,20,30,'mail.exe')",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            let pending = database.prepare_restore(backup_path).await.unwrap();
            assert_eq!(pending.schema_version, SCHEMA_VERSION);
            database.close().await;

            let swap = TimeDatabase::begin_pending_restore(&path)
                .await
                .unwrap()
                .unwrap();
            assert!(root.join("restore_previous.db").exists());
            let restored = TimeDatabase::open(path.clone()).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
                .fetch_one(&restored.pool)
                .await
                .unwrap();
            assert_eq!(count, 1);
            restored.close().await;
            swap.commit().unwrap();
            assert!(!root.join("restore_previous.db").exists());
            assert!(!root.join("restore_pending.json").exists());
        });
    }

    #[test]
    fn fresh_database_has_essential_private_defaults() {
        let path = scratch_database("database-bootstrap-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            let categories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories")
                .fetch_one(&database.pool)
                .await
                .unwrap();
            let rules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rules")
                .fetch_one(&database.pool)
                .await
                .unwrap();
            let consent: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='recording_consent'")
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            let titles: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='record_window_titles'")
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            let tray_icon: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='show_tray_icon'")
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            let starter_pending: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key='starter_categories_pending'",
            )
            .fetch_one(&database.pool)
            .await
            .unwrap();
            let update_checks: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key='check_updates_automatically'",
            )
            .fetch_one(&database.pool)
            .await
            .unwrap();
            assert_eq!(
                (
                    categories,
                    rules,
                    consent.as_str(),
                    titles.as_str(),
                    tray_icon.as_str(),
                    starter_pending.as_str(),
                    update_checks.as_str()
                ),
                (6, 0, "0", "0", "1", "1", "1")
            );
            // The same list test_seed_categories_and_settings_present asserts on
            // the Python side. Either half may create the database first, so the
            // two seed declarations drifting would hand one user a taxonomy the
            // other never sees — and nothing else fails when it happens.
            let seeded: Vec<(String, i64, i64, i64)> = sqlx::query_as(
                "SELECT name, is_productive, is_neutral, is_ignored FROM categories ORDER BY sort_order",
            )
            .fetch_all(&database.pool)
            .await
            .unwrap();
            let seeded: Vec<(&str, i64, i64, i64)> = seeded
                .iter()
                .map(|(name, productive, neutral, ignored)| {
                    (name.as_str(), *productive, *neutral, *ignored)
                })
                .collect();
            assert_eq!(
                seeded,
                vec![
                    ("Work", 1, 0, 0),
                    ("Communication", 0, 1, 0),
                    ("Browsing", 0, 1, 0),
                    ("Entertainment", 0, 0, 0),
                    ("System", 0, 1, 0),
                    ("Ignored", 0, 0, 1),
                ]
            );
            database.close().await;
        });
    }

    #[test]
    fn existing_taxonomy_does_not_receive_starter_categories() {
        let path = scratch_database("database-existing-taxonomy-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            sqlx::query("DELETE FROM categories")
                .execute(&database.pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM settings WHERE key='starter_categories_pending'")
                .execute(&database.pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO categories (name,color,sort_order) VALUES ('Personal','#123456',1)",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            database.close().await;

            let reopened = TimeDatabase::open(path.clone()).await.unwrap();
            let names: Vec<String> =
                sqlx::query_scalar("SELECT name FROM categories ORDER BY sort_order")
                    .fetch_all(&reopened.pool)
                    .await
                    .unwrap();
            let marker: Option<String> = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key='starter_categories_pending'",
            )
            .fetch_optional(&reopened.pool)
            .await
            .unwrap();
            assert_eq!(names, vec!["Personal"]);
            assert_eq!(marker, None);
            reopened.close().await;
        });
    }

    #[test]
    fn session_read_is_columnar_ordered_and_windowed() {
        let path = scratch_database("database-session-columns-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            for values in [
                (1_i64, 50_i64, 60_i64, "first.exe", 0_i64),
                (2, 20, 30, "second.exe", 1),
                (3, 150, 160, "outside.exe", 0),
            ] {
                sqlx::query(
                    "INSERT INTO sessions (id,start_ts,end_ts,process,title,is_afk) \
                     VALUES (?,?,?,?,?,?)",
                )
                .bind(values.0)
                .bind(values.1)
                .bind(values.2)
                .bind(values.3)
                .bind("")
                .bind(values.4)
                .execute(&database.pool)
                .await
                .unwrap();
            }

            let sessions = database.fetch_sessions(10.0, 100.0, -1.0).await.unwrap();
            assert_eq!(sessions.ids, vec![2, 1]);
            assert_eq!(sessions.starts, vec![20, 50]);
            assert_eq!(sessions.ends, vec![30, 60]);
            assert_eq!(sessions.processes, vec!["second.exe", "first.exe"]);
            assert_eq!(sessions.is_afk, vec![true, false]);
        });
    }

    #[test]
    fn activity_delete_is_exact_and_snapshot_bounded() {
        let path = scratch_database("database-activity-delete-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            for values in [
                (1_i64, "chrome.exe", Some("example.com")),
                (2, "chrome.exe", Some("other.com")),
                (3, "chrome.exe", None),
                (4, "code.exe", None),
            ] {
                sqlx::query(
                    "INSERT INTO sessions (id,start_ts,end_ts,process,domain) VALUES (?,?,?, ?,?)",
                )
                .bind(values.0)
                .bind(values.0 * 20)
                .bind(values.0 * 20 + 10)
                .bind(values.1)
                .bind(values.2)
                .execute(&database.pool)
                .await
                .unwrap();
            }
            let mut request = ActivityDeleteRequest {
                mode: "entity".into(),
                session_ids: vec![],
                entity_kind: Some("website".into()),
                entity_key: Some("example.com".into()),
                start_sec: Some(0.0),
                end_sec: Some(1_000.0),
                browser_processes: vec!["chrome.exe".into()],
                snapshot_max_id: None,
                preview_protected_session_id: None,
            };
            let preview = database.preview_activity_delete(&request).await.unwrap();
            assert_eq!(
                (preview.count, preview.seconds, preview.snapshot_max_id),
                (1, 10, 4)
            );

            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,domain) \
                 VALUES (5,100,110,'chrome.exe','example.com')",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            request.snapshot_max_id = Some(preview.snapshot_max_id);
            request.preview_protected_session_id = preview.protected_session_id;
            let deleted = database.delete_activity(&request).await.unwrap();
            assert_eq!(deleted.deleted_count, 1);
            let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
                .fetch_all(&database.pool)
                .await
                .unwrap();
            assert_eq!(remaining, vec![2, 3, 4, 5]);

            let app_preview = database
                .preview_activity_delete(&ActivityDeleteRequest {
                    mode: "entity".into(),
                    session_ids: vec![],
                    entity_kind: Some("app".into()),
                    entity_key: Some("chrome.exe".into()),
                    start_sec: Some(0.0),
                    end_sec: Some(1_000.0),
                    browser_processes: vec!["chrome.exe".into()],
                    snapshot_max_id: None,
                    preview_protected_session_id: None,
                })
                .await
                .unwrap();
            assert_eq!(app_preview.count, 1);

            let mut selected_request = ActivityDeleteRequest {
                mode: "sessions".into(),
                session_ids: vec![2, 4, 999],
                entity_kind: None,
                entity_key: None,
                start_sec: None,
                end_sec: None,
                browser_processes: vec![],
                snapshot_max_id: None,
                preview_protected_session_id: None,
            };
            let selected_preview = database
                .preview_activity_delete(&selected_request)
                .await
                .unwrap();
            assert_eq!((selected_preview.count, selected_preview.seconds), (2, 20));
            selected_request.snapshot_max_id = Some(selected_preview.snapshot_max_id);
            selected_request.preview_protected_session_id = selected_preview.protected_session_id;
            let selected_deleted = database.delete_activity(&selected_request).await.unwrap();
            assert_eq!(selected_deleted.deleted_count, 2);
            let selected_remaining: Vec<i64> =
                sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
                    .fetch_all(&database.pool)
                    .await
                    .unwrap();
            assert_eq!(selected_remaining, vec![3, 5]);
            let free_pages: i64 = sqlx::query_scalar("PRAGMA freelist_count")
                .fetch_one(&database.pool)
                .await
                .unwrap();
            assert_eq!(free_pages, 0);
        });
    }

    #[test]
    fn targeted_and_retention_deletion_reject_a_newer_schema() {
        let path = scratch_database("database-activity-newer-schema-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            sqlx::query("UPDATE settings SET value='999' WHERE key='schema_version'")
                .execute(&database.pool)
                .await
                .unwrap();
            database.close().await;

            let newer = TimeDatabase::open(path).await.unwrap();
            let request = ActivityDeleteRequest {
                mode: "sessions".into(),
                session_ids: vec![1],
                entity_kind: None,
                entity_key: None,
                start_sec: None,
                end_sec: None,
                browser_processes: vec![],
                snapshot_max_id: Some(1),
                preview_protected_session_id: None,
            };
            assert!(newer.delete_activity(&request).await.is_err());
            assert!(newer.delete_history_before(100.0).await.is_err());
        });
    }

    #[test]
    fn activity_delete_protects_the_recent_live_edge() {
        let path = scratch_database("database-activity-live-edge-test");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path).await.unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,source) \
                 VALUES (1,?,?, 'code.exe','live')",
            )
            .bind(now - 20)
            .bind(now)
            .execute(&database.pool)
            .await
            .unwrap();
            sqlx::query("UPDATE settings SET value='1' WHERE key='recording_consent'")
                .execute(&database.pool)
                .await
                .unwrap();
            let mut request = ActivityDeleteRequest {
                mode: "sessions".into(),
                session_ids: vec![1],
                entity_kind: None,
                entity_key: None,
                start_sec: None,
                end_sec: None,
                browser_processes: vec![],
                snapshot_max_id: None,
                preview_protected_session_id: None,
            };
            let protected = database.preview_activity_delete(&request).await.unwrap();
            assert_eq!((protected.count, protected.protected_count), (0, 1));

            sqlx::query("UPDATE settings SET value='1' WHERE key='tracking_paused'")
                .execute(&database.pool)
                .await
                .unwrap();
            request.snapshot_max_id = Some(protected.snapshot_max_id);
            request.preview_protected_session_id = protected.protected_session_id;
            let unchanged = database.delete_activity(&request).await.unwrap();
            assert_eq!((unchanged.deleted_count, unchanged.protected_count), (0, 1));
            let still_present: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id=1")
                .fetch_one(&database.pool)
                .await
                .unwrap();
            assert_eq!(still_present, 1);

            request.snapshot_max_id = None;
            request.preview_protected_session_id = None;
            let paused = database.preview_activity_delete(&request).await.unwrap();
            assert_eq!((paused.count, paused.protected_count), (1, 0));
            request.snapshot_max_id = Some(paused.snapshot_max_id);
            request.preview_protected_session_id = paused.protected_session_id;
            let deleted = database.delete_activity(&request).await.unwrap();
            assert_eq!(deleted.deleted_count, 1);
        });
    }

    #[test]
    fn recording_schedule_handles_daytime_and_overnight_windows() {
        assert!(schedule_allows_local(
            true,
            "0,1,2,3,4",
            "540",
            "1020",
            0,
            540
        ));
        assert!(!schedule_allows_local(
            true,
            "0,1,2,3,4",
            "540",
            "1020",
            0,
            1020
        ));
        assert!(schedule_allows_local(true, "0", "1320", "360", 0, 1380));
        assert!(schedule_allows_local(true, "0", "1320", "360", 1, 359));
        assert!(!schedule_allows_local(true, "0", "1320", "360", 1, 360));
    }

    #[test]
    fn recording_schedule_fails_closed_when_enabled_but_invalid() {
        assert!(!schedule_allows_local(true, "", "540", "1020", 0, 600));
        assert!(!schedule_allows_local(true, "0", "540", "540", 0, 600));
        assert!(schedule_allows_local(false, "", "540", "540", 0, 600));
    }
}
