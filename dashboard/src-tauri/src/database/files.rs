//! File operations that must survive Windows sharing violations and an open WAL.

use super::*;
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::{fs, path::Path, time::Duration};

impl TimeDatabase {
    /// Retry a file operation that a transient Windows lock can fail.
    ///
    /// Windows releases a database file a moment *after* the close future that
    /// owned it resolves, so there is nothing the restore can await before
    /// renaming or deleting it. `RUST_TEST_THREADS` narrowed that window enough
    /// to make the suite usually pass; it cannot close it, and a real machine
    /// has antivirus and search indexers opening files behind Time's back
    /// besides. Retrying briefly is the only thing that makes these operations
    /// deterministic.
    ///
    /// The sleep blocks rather than yields. Every caller reaches this through
    /// `block_on` during startup, before there is anything else to run, and a
    /// blocking sleep keeps the helper usable from `RestoreSwap`'s synchronous
    /// commit and rollback paths too.
    ///
    /// None of this is a licence to unserialize the test suite. At
    /// `RUST_TEST_THREADS=16` the restore tests still fail about once in sixty,
    /// because a blocked thread can starve the very `sqlite3_close` it waits on
    /// — the retry narrows the window, `RUST_TEST_THREADS` in `/.cargo/config.toml`
    /// is what closes it, and both are load-bearing. Making the wait yield
    /// instead means an async retry, which turns `remove_if_exists` and
    /// `write_json_atomic` async and ripples through `RestoreSwap`'s synchronous
    /// commit and rollback paths; not worth it while the suite is serialized
    /// everywhere it runs.
    pub(super) fn retry_while_locked<T>(
        mut operation: impl FnMut() -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        // ERROR_SHARING_VIOLATION, plus ERROR_ACCESS_DENIED for the
        // delete-pending state a handle that is still closing leaves behind.
        // Rust maps neither to a distinct `ErrorKind`, so match the raw codes.
        const TRANSIENT: [i32; 2] = [32, 5];
        // Half a second, and deliberately not more. sqlx finishes
        // `sqlite3_close` on a background thread after `pool.close()` has
        // already resolved, so what this waits on needs a thread to make
        // progress — and the sleep below blocks rather than yields. Raising the
        // budget to two seconds made a heavily oversubscribed run fail *more*
        // often (4 in 60, against 1 in 100 at this setting): the longer wait
        // starves the close it is waiting for. Half a second clears the lag
        // without holding a runtime thread long enough to cause one.
        const ATTEMPTS: u32 = 25;
        const BACKOFF: Duration = Duration::from_millis(20);

        let mut attempts = 0;
        loop {
            let error = match operation() {
                Ok(value) => return Ok(value),
                Err(error) => error,
            };
            attempts += 1;
            let transient = error
                .raw_os_error()
                .is_some_and(|code| TRANSIENT.contains(&code));
            if !transient || attempts >= ATTEMPTS {
                return Err(error);
            }
            std::thread::sleep(BACKOFF);
        }
    }

    /// Every failure here names the file. The error a sharing violation carries
    /// says only that "another process" holds "the file", and a restore touches
    /// six of them, so without the path a CI failure cannot be diagnosed at all.
    pub(super) fn remove_if_exists(path: &Path) -> Result<(), String> {
        match Self::retry_while_locked(|| fs::remove_file(path)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("could not remove {}: {error}", path.display())),
        }
    }

    pub(super) fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
        Self::retry_while_locked(|| fs::rename(from, to)).map_err(|error| {
            format!(
                "could not rename {} to {}: {error}",
                from.display(),
                to.display()
            )
        })
    }

    pub(super) fn copy_with_retry(from: &Path, to: &Path) -> Result<(), String> {
        Self::retry_while_locked(|| fs::copy(from, to))
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "could not copy {} to {}: {error}",
                    from.display(),
                    to.display()
                )
            })
    }

    pub(super) fn remove_database_sidecars(path: &Path) -> Result<(), String> {
        Self::remove_if_exists(&path.with_extension("db-wal"))?;
        Self::remove_if_exists(&path.with_extension("db-shm"))
    }

    /// Fold a database's write-ahead log into its main file.
    ///
    /// Always call this before dropping a `-wal`. A log is not a cache: the
    /// rows it holds are only in the database while the pair stays together,
    /// and a restore has to break the pair — the file being replaced must never
    /// be left beside a log belonging to the database that replaced it. The
    /// tracker is force-stopped for a restore and its last minutes are still in
    /// the log when it dies, so deleting the log instead of folding it in threw
    /// away exactly the recording the safety copy exists to protect.
    pub(super) async fn checkpoint_wal(path: &Path) -> Result<(), String> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| format!("Could not open the database: {error}"))?;
        let checkpoint = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await;
        pool.close().await;
        checkpoint
            .map(|_| ())
            .map_err(|error| format!("Could not fold in the write-ahead log: {error}"))
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
    pub(super) async fn stage_consolidated_copy(
        source: &Path,
        destination: &Path,
    ) -> Result<(), String> {
        Self::remove_if_exists(destination)?;
        Self::remove_database_sidecars(destination)?;
        // The copies take the same treatment as the deletes and renames: the
        // destination is a file this process may itself have closed moments
        // ago, and opening it for writing is as lockable as removing it.
        Self::copy_with_retry(source, destination)?;
        let source_log = source.with_extension("db-wal");
        if source_log.is_file() {
            Self::copy_with_retry(&source_log, &destination.with_extension("db-wal"))?;
        }

        Self::checkpoint_wal(destination)
            .await
            .map_err(|error| format!("Could not read backup: {error}"))?;
        Self::remove_database_sidecars(destination)
    }

    pub(super) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        Self::remove_if_exists(path)?;
        Self::rename_with_retry(&temporary, path)
    }
}
