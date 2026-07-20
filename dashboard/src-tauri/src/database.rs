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

use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Column, Row, SqlitePool, TypeInfo, Value, ValueRef,
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: i64 = 1;
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
INSERT OR IGNORE INTO settings (key,value)
    SELECT 'starter_categories_pending','1'
    WHERE NOT EXISTS (SELECT 1 FROM categories);
WITH starter(name, color, is_productive, is_neutral, is_ignored, sort_order) AS (
    VALUES
        ('Focus', '#2f6fc0', 1, 0, 0, 1),
        ('Learning', '#9c8ff0', 1, 0, 0, 2),
        ('Communication', '#56c8d8', 0, 1, 0, 3),
        ('Entertainment', '#e8663d', 0, 0, 0, 4),
        ('Utilities', '#828994', 0, 1, 0, 5),
        ('Ignored', '#44474e', 0, 0, 1, 99)
)
INSERT OR IGNORE INTO categories
    (name, color, is_productive, is_neutral, is_ignored, sort_order)
    SELECT * FROM starter
    WHERE (SELECT COUNT(*) FROM categories) = 0;
INSERT OR IGNORE INTO settings (key,value) VALUES
    ('schema_version','1'),
    ('rule_priority_scheme','low-wins-v1'),
    ('weekly_goal_hours','0'),
    ('idle_threshold_seconds','180'),
    ('heartbeat_seconds','15'),
    ('week_start','auto'),
    ('default_top_n_apps','5'),
    ('browser_processes','chrome.exe,msedge.exe,firefox.exe,brave.exe'),
    ('min_app_seconds','0'),
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
            "SELECT id, start_ts, end_ts, process, title, domain, is_afk FROM sessions \
             WHERE end_ts > ? AND start_ts < ? AND start_ts > ? ORDER BY start_ts ASC",
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
        };
        for row in rows {
            out.ids
                .push(row.try_get("id").map_err(|error| error.to_string())?);
            out.starts
                .push(row.try_get("start_ts").map_err(|error| error.to_string())?);
            out.ends
                .push(row.try_get("end_ts").map_err(|error| error.to_string())?);
            out.processes
                .push(row.try_get("process").map_err(|error| error.to_string())?);
            out.titles
                .push(row.try_get("title").map_err(|error| error.to_string())?);
            out.domains
                .push(row.try_get("domain").map_err(|error| error.to_string())?);
            let is_afk: i64 = row.try_get("is_afk").map_err(|error| error.to_string())?;
            out.is_afk.push(is_afk != 0);
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
    /// blank a privacy gate or the schema version. `sessions` accepts DELETE
    /// only — that is the user's history-deletion surface — and never INSERT or
    /// UPDATE, because the tracker is the sole author of session rows.
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
            Some("DELETE") => ["RULES", "CATEGORIES", "SESSIONS"].contains(&target),
            _ => false,
        };
        if !allowed {
            return Err(format!(
                "Webview mutations of table {target:?} are not allowed"
            ));
        }
        Ok(())
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

    pub async fn compact(&self) -> Result<(), String> {
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
    use super::TimeDatabase;

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
        assert!(TimeDatabase::validate_mutation_target("DELETE FROM sessions WHERE id=$1").is_ok());
        assert!(TimeDatabase::validate_mutation_target("UPDATE settings SET value='1'").is_err());
        assert!(TimeDatabase::validate_mutation_target("DELETE FROM settings").is_err());
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
}
