//! The dashboard's native SQLite connection (the tracker has its own runtime
//! connection to the same WAL database).
//!
//! The webview never touches the file; it sends reads and fixed structured
//! writes through native commands. Category/rule SQL still arrives through
//! `db_execute` as untrusted input; settings use the structured allowlist and
//! transaction in `settings`. `validate_sql` and `validate_mutation_target` in
//! `guard` are the boundary for that SQL — read both before changing either.
//!
//! The bootstrap schema in `schema` is duplicated in `tracker/db.py`, because
//! either half may legitimately create the database first (dashboard opened
//! before the tracker's first run, or the reverse). The two must stay
//! identical; the Python side owns migrations.

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    SqlitePool,
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

mod backup;
mod corrections;
mod exclusions;
mod files;
mod guard;
mod history;
mod restore;
mod rules;
mod schema;
mod sessions;
mod settings;
mod sql;
#[cfg(test)]
mod tests;

pub use backup::DatabaseBackup;
pub use corrections::{
    SessionClassificationRequest, SessionClassificationResult, SessionCorrection,
    SessionCorrectionRequest,
};
pub use exclusions::{TrackingExclusion, TrackingExclusionPreview, TrackingExclusionResult};
pub use history::{ActivityDeletePreview, ActivityDeleteRequest, ActivityDeleteResult};
pub use restore::RestoreNotice;
// Named outside this module only by lifecycle's tests.
#[cfg(test)]
pub(crate) use restore::PendingRestore;
pub use rules::{EntityRuleAssignment, EntityRuleChange};
pub(crate) use schema::{is_older_schema_error, SCHEMA_VERSION};
use schema::{BOOTSTRAP_SQL, OLDER_SCHEMA_PREFIX};
pub use sessions::SessionColumns;
pub(crate) use settings::LifecycleSettings;
pub use settings::SettingUpdate;
pub use sql::ExecuteResult;

pub struct TimeDatabase {
    pool: SqlitePool,
    path: PathBuf,
    schema_version: i64,
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

fn unix_now() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|error| error.to_string())
}

pub fn database_path(base: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TIME_DB_PATH") {
        return PathBuf::from(path);
    }
    base.join("Time").join("Data").join("database.db")
}

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

    #[cfg(test)]
    pub(crate) fn test_pool(&self) -> &SqlitePool {
        &self.pool
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
                // Prefixed so the launch path can tell this apart from every
                // other reason an open fails and hand the database to the
                // tracker, which owns migration.  Nothing else may act on it:
                // this release cannot read the older shape, and the bootstrap
                // SQL below must not run against it.
                if version < SCHEMA_VERSION {
                    return Err(format!(
                        "{OLDER_SCHEMA_PREFIX} database schema {version} requires an explicit \
                         migration to {SCHEMA_VERSION}"
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
