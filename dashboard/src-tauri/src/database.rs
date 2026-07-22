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

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Column, Row, SqlitePool, TypeInfo, Value, ValueRef,
};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: i64 = 2;
const MAX_SESSION_SPAN_SEC: i64 = 7 * 86_400;
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
    UNIQUE(match_type, pattern)
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
        ('Focus', '#2f6fc0', 1, 0, 0, 1),
        ('Learning', '#9c8ff0', 1, 0, 0, 2),
        ('Communication', '#56c8d8', 0, 1, 0, 3),
        ('Entertainment', '#e75fa0', 0, 0, 0, 4),
        ('Utilities', '#828994', 0, 1, 0, 5),
        ('Ignored', '#44474e', 0, 0, 1, 99)
)
INSERT OR IGNORE INTO categories
    (name, color, is_productive, is_neutral, is_ignored, sort_order)
    SELECT * FROM starter
    WHERE (SELECT COUNT(*) FROM categories) = 0;
INSERT OR IGNORE INTO settings (key,value) VALUES
    ('schema_version','2'),
    ('rule_priority_scheme','low-wins-v1'),
    ('weekly_goal_hours','0'),
    ('idle_threshold_seconds','180'),
    ('heartbeat_seconds','15'),
    ('week_start','auto'),
    ('browser_processes','chrome.exe,msedge.exe,firefox.exe,brave.exe,opera.exe,vivaldi.exe,arc.exe,chromium.exe'),
    ('min_app_seconds_per_day','0'),
    ('focus_chain_max_gap_seconds','120'),
    ('day_start_hour','0'),
    ('day_end_hour','24'),
    ('tracking_paused','0'),
    ('tracking_paused_until','0'),
    ('recording_consent','0'),
    ('record_window_titles','0'),
    ('privacy_onboarding_complete','0'),
    ('launch_at_login','0');
COMMIT;
"#;

pub struct TimeDatabase {
    pool: SqlitePool,
    path: PathBuf,
    schema_version: i64,
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

impl TimeDatabase {
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
            .map_err(|e| e.to_string())?;
        let schema_version = if preexisting {
            let settings_exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            )
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())?;
            if settings_exists == 0 {
                let user_tables: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .fetch_one(&pool)
                .await
                .map_err(|e| e.to_string())?;
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
                .map_err(|e| e.to_string())?
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
            .map_err(|e| e.to_string())?;
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
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|row| {
                let mut out = Map::new();
                for (index, column) in row.columns().iter().enumerate() {
                    let raw = row.try_get_raw(index).map_err(|e| e.to_string())?;
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
        let rows = sqlx::query(
            "SELECT s.id,COALESCE(c.corrected_start_ts,s.start_ts) AS effective_start, \
             COALESCE(c.corrected_end_ts,s.end_ts) AS effective_end,s.process,s.title,s.domain, \
             s.is_afk,c.category_id,c.session_id IS NOT NULL AS is_corrected \
             FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id \
             WHERE COALESCE(c.corrected_end_ts,s.end_ts)>? \
             AND COALESCE(c.corrected_start_ts,s.start_ts)<? \
             AND COALESCE(c.corrected_start_ts,s.start_ts)>? \
             ORDER BY effective_start ASC,s.id ASC",
        )
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
        let result = query.execute(&self.pool).await.map_err(|e| e.to_string())?;
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
        let target = match words.as_slice() {
            [verb, into, table, ..] if verb == "INSERT" && into == "INTO" => table.as_str(),
            [verb, table, ..] if verb == "UPDATE" => table.as_str(),
            [verb, from, table, ..] if verb == "DELETE" && from == "FROM" => table.as_str(),
            _ => return Err("Unsupported SQL mutation shape".into()),
        };
        let allowed = match words.first().map(String::as_str) {
            Some("INSERT") => ["SETTINGS", "RULES", "CATEGORIES"].contains(&target),
            Some("UPDATE") => ["CATEGORIES"].contains(&target),
            Some("DELETE") => ["RULES", "CATEGORIES"].contains(&target),
            _ => false,
        };
        if !allowed {
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
            for chunk in ids.chunks(500) {
                let placeholders = std::iter::repeat_n("?", chunk.len())
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT s.id,COALESCE(c.corrected_start_ts,s.start_ts) AS effective_start, \
                     COALESCE(c.corrected_end_ts,s.end_ts) AS effective_end FROM sessions s \
                     LEFT JOIN session_corrections c ON c.session_id=s.id \
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
        let rows = match entity_kind {
            "app" => sqlx::query(
                "SELECT s.id,COALESCE(c.corrected_start_ts,s.start_ts) AS effective_start, \
                 COALESCE(c.corrected_end_ts,s.end_ts) AS effective_end,s.process,s.domain \
                 FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id \
                 WHERE lower(s.process)=? AND COALESCE(c.corrected_end_ts,s.end_ts)>? \
                 AND COALESCE(c.corrected_start_ts,s.start_ts)<?",
            )
            .bind(&entity_key)
            .bind(start_sec)
            .bind(end_sec)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?,
            "website" => sqlx::query(
                "SELECT s.id,COALESCE(c.corrected_start_ts,s.start_ts) AS effective_start, \
                 COALESCE(c.corrected_end_ts,s.end_ts) AS effective_end,s.process,s.domain \
                 FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id \
                 WHERE lower(IFNULL(s.domain,''))=? AND COALESCE(c.corrected_end_ts,s.end_ts)>? \
                 AND COALESCE(c.corrected_start_ts,s.start_ts)<?",
            )
            .bind(&entity_key)
            .bind(start_sec)
            .bind(end_sec)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?,
            _ => return Err("Unsupported Activity entity kind".into()),
        };
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
             ('recording_consent','tracking_paused','tracking_paused_until','heartbeat_seconds')",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let mut consent = false;
        let mut paused = false;
        let mut paused_until = 0_i64;
        let mut heartbeat = 15_i64;
        for row in rows {
            let key: String = row.try_get("key").map_err(|error| error.to_string())?;
            let value: String = row.try_get("value").map_err(|error| error.to_string())?;
            match key.as_str() {
                "recording_consent" => consent = value == "1",
                "tracking_paused" => paused = value == "1",
                "tracking_paused_until" => paused_until = value.parse().unwrap_or(0),
                "heartbeat_seconds" => heartbeat = value.parse().unwrap_or(15),
                _ => {}
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs() as i64;
        if !consent || paused || paused_until > now {
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
        for chunk in ids.chunks(500) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
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
             FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id WHERE {predicate}"
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
        let row = sqlx::query(
            "SELECT s.id,s.start_ts,s.end_ts,s.process,s.title,s.domain,s.is_afk, \
             COALESCE(c.corrected_start_ts,s.start_ts) AS effective_start, \
             COALESCE(c.corrected_end_ts,s.end_ts) AS effective_end,c.category_id, \
             c.session_id IS NOT NULL AS is_corrected \
             FROM sessions s LEFT JOIN session_corrections c ON c.session_id=s.id WHERE s.id=?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Session no longer exists")?;
        let protected = self.protected_live_session_id().await?;
        Ok(SessionCorrection {
            session_id,
            original_start: row.try_get("start_ts").map_err(|error| error.to_string())?,
            original_end: row.try_get("end_ts").map_err(|error| error.to_string())?,
            start: row
                .try_get("effective_start")
                .map_err(|error| error.to_string())?,
            end: row
                .try_get("effective_end")
                .map_err(|error| error.to_string())?,
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
        let overlaps: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions s \
             LEFT JOIN session_corrections c ON c.session_id=s.id \
             WHERE s.id<>? AND COALESCE(c.corrected_end_ts,s.end_ts)>? \
             AND COALESCE(c.corrected_start_ts,s.start_ts)<?",
        )
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

    pub async fn delete_history_before(&self, cutoff_sec: f64) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        if !cutoff_sec.is_finite() {
            return Err("Invalid history cutoff".into());
        }
        let result = sqlx::query(
            "DELETE FROM sessions WHERE id IN (SELECT s.id FROM sessions s \
             LEFT JOIN session_corrections c ON c.session_id=s.id \
             WHERE COALESCE(c.corrected_end_ts,s.end_ts) < ?)",
        )
        .bind(cutoff_sec.floor() as i64)
        .execute(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        if result.rows_affected() > 0 {
            self.compact().await?;
        }
        Ok(result.rows_affected())
    }

    pub async fn backup(&self) -> Result<String, String> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        let target = self
            .path
            .with_file_name(format!("backup_manual_{stamp}.db"));
        let escaped = target.to_string_lossy().replace("'", "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    }

    pub async fn erase_history(&self) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        let result = sqlx::query("DELETE FROM sessions")
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
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
            .map_err(|e| e.to_string())?;
        sqlx::query("VACUUM")
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
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
            .map_err(|e| e.to_string()),
        "REAL" => raw
            .to_owned()
            .try_decode::<f64>()
            .map(JsonValue::from)
            .map_err(|e| e.to_string()),
        "INTEGER" | "NUMERIC" | "BOOLEAN" => raw
            .to_owned()
            .try_decode::<i64>()
            .map(JsonValue::from)
            .map_err(|e| e.to_string()),
        "BLOB" => raw
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|bytes| JsonValue::Array(bytes.into_iter().map(JsonValue::from).collect()))
            .map_err(|e| e.to_string()),
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
    use super::{ActivityDeleteRequest, SessionCorrectionRequest, TimeDatabase};

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
        assert!(TimeDatabase::validate_mutation_target("UPDATE settings SET value='1'").is_err());
        assert!(TimeDatabase::validate_mutation_target("DELETE FROM settings").is_err());
    }

    #[test]
    fn exclusions_are_normalized_and_can_atomically_delete_history() {
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-exclusion-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
        assert_eq!(super::normalize_exclusion("app", " Code ").unwrap(), "code.exe");
        assert_eq!(super::normalize_exclusion("app", "CODE.EXE").unwrap(), "code.exe");
        // A dotted name is already specific enough to match on its own.
        assert_eq!(super::normalize_exclusion("app", "vim.bat").unwrap(), "vim.bat");
        assert!(super::normalize_exclusion("app", "C:\\apps\\code.exe").is_err());
    }

    #[test]
    fn corrections_overlay_raw_sessions_and_validate_timeline_rules() {
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-correction-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
    fn fresh_database_has_essential_private_defaults() {
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-bootstrap-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
            let starter_pending: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key='starter_categories_pending'",
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
                    starter_pending.as_str()
                ),
                (6, 0, "0", "0", "1")
            );
            database.pool.close().await;
            drop(database);
        });
    }

    #[test]
    fn existing_taxonomy_does_not_receive_starter_categories() {
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-existing-taxonomy-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
            database.pool.close().await;
            drop(database);

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
            reopened.pool.close().await;
            drop(reopened);
        });
    }

    #[test]
    fn session_read_is_columnar_ordered_and_windowed() {
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-session-columns-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-activity-delete-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-activity-newer-schema-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            sqlx::query("UPDATE settings SET value='999' WHERE key='schema_version'")
                .execute(&database.pool)
                .await
                .unwrap();
            database.pool.close().await;
            drop(database);

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
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("database-activity-live-edge-test.db");
        for candidate in [
            path.clone(),
            path.with_extension("db-wal"),
            path.with_extension("db-shm"),
        ] {
            if candidate.exists() {
                std::fs::remove_file(candidate).unwrap();
            }
        }
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
}
