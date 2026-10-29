use std::path::{Path, PathBuf};

use crate::database::{is_older_schema_error, RestoreNotice, TimeDatabase, SCHEMA_VERSION};
use crate::platform;

/// Open the live database, letting the tracker migrate it first if it predates
/// this release.
///
/// The tracker is the sole migration owner, and the restore path below already
/// runs it before reopening an older snapshot. The ordinary launch did not,
/// which left the upgrade it is far more likely to meet unhandled. An in-place
/// upgrade migrates through the new installer's POSTINSTALL hook, and that hook
/// starts the tracker with NSIS `Exec` — fire and forget. Both the finish
/// page's "run now" box and the updater's passive relaunch race it, and the
/// dashboard wins that race easily: it is a webview with the database already
/// on disk, while the tracker is a PyInstaller bundle that has to unpack itself
/// before it opens anything.
///
/// Losing that race used to end the launch. The error propagates out of
/// `setup()`, Tauri refuses to start, and the release binary is built
/// windows-subsystem, so the panic has nowhere to print: Time simply does not
/// open, with no way to tell that from a broken install. Migrating here makes
/// the launch self-sufficient whatever the installer's timing did, rather than
/// correct only when the hook happens to win.
fn open_current_database(path: PathBuf) -> Result<TimeDatabase, String> {
    match tauri::async_runtime::block_on(TimeDatabase::open(path.clone())) {
        Err(error) if is_older_schema_error(&error) => {
            // Both halves of the failure are worth keeping: the migration's own
            // error says why it could not run, and the original says what the
            // database needed, which is the pair somebody debugging a machine
            // that will not start has to see together.
            if let Err(cause) = platform::run_tracker_migration() {
                return Err(migration_failure(&error, Some(&cause), &path));
            }
            match tauri::async_runtime::block_on(TimeDatabase::open(path.clone())) {
                // A clean exit that left the schema behind once passed as
                // success and ended in the bare error, with nothing on screen
                // to say the tracker had not even tried.
                Err(again) if is_older_schema_error(&again) => {
                    Err(migration_failure(&again, None, &path))
                }
                result => result,
            }
        }
        result => result,
    }
}

/// The fatal-launch text for a migration that did not happen. It names the
/// tracker's log, because that is where the reason is and the dialog is the
/// only thing a reader whose Time will not start can see.
fn migration_failure(error: &str, cause: Option<&str>, database: &Path) -> String {
    let cause = cause.unwrap_or("the tracker exited without migrating it");
    // Mirrors LOG_PATH in tracker/config.py: Logs beside the database.
    let log = database
        .parent()
        .unwrap_or(database)
        .join("Logs")
        .join("tracker.log");
    format!("{error}; {cause}. Details are in {}", log.display())
}

/// Restore bookkeeping that must never cost the reader their application.
///
/// The notice is how the next screen explains what happened to the database, and
/// writing it is the last thing every path below does. It is also the least
/// important: the database is already swapped, opened, and correct by then, or
/// already rolled back and correct. An `Err` out of this function propagates from
/// `setup()`, which means Tauri refuses to start — so a failed write of a
/// courtesy message used to take the whole app down and leave a reader who had
/// just restored a backup with a dead launch and no way to tell that their data
/// was, in fact, fine. Losing the sentence is the correct trade.
fn best_effort(result: Result<(), String>) {
    let _ = result;
}

pub(crate) fn open_database_with_pending_restore(path: PathBuf) -> Result<TimeDatabase, String> {
    let pending = tauri::async_runtime::block_on(TimeDatabase::begin_pending_restore(&path));
    let swap = match pending {
        Ok(Some(swap)) => swap,
        Ok(None) => return open_current_database(path),
        Err(error) => {
            // A failed rollback can leave both databases present. Preserve the
            // marker in that case too; discarding it would abandon the original
            // and treat an unvalidated replacement as a completed restore.
            if TimeDatabase::restore_needs_recovery(&path) {
                return Err(format!(
                    "Restore could not be completed and the previous database is not back in \
                     place: {error}"
                ));
            }
            let message = format!(
                "Restore was canceled and your existing data was left unchanged. \
                 You can try the restore again: {error}"
            );
            // Cleanup and the notice together, and neither is worth refusing to
            // start over: a marker that survives only means the next launch
            // retries a swap that is already known to fail, which lands right
            // back here rather than anywhere dangerous.
            best_effort(TimeDatabase::discard_pending_restore(&path, message));
            return open_current_database(path);
        }
    };
    let restored = swap.pending.clone();
    let opened = (|| {
        if restored.schema_version < SCHEMA_VERSION {
            platform::run_tracker_migration()?;
        }
        tauri::async_runtime::block_on(TimeDatabase::open(path.clone()))
    })();
    let database = match opened {
        Ok(database) => database,
        Err(error) => {
            if let Err(rollback) = swap.rollback() {
                return Err(format!(
                    "Restore failed ({error}), and Time could not put the previous database back: {rollback}"
                ));
            }
            let message =
                format!("Restore failed and the previous database was put back unchanged: {error}");
            best_effort(TimeDatabase::write_restore_notice(
                &path,
                RestoreNotice { ok: false, message },
            ));
            return open_current_database(path);
        }
    };

    let mut warnings = Vec::new();
    if let Err(error) =
        platform::set_launch_at_login(restored.recording_consent && restored.launch_at_login)
    {
        warnings.push(format!("Windows startup could not be updated: {error}"));
    }
    if restored.recording_consent {
        if let Err(error) = platform::start_tracker() {
            warnings.push(format!("the tracker could not be restarted: {error}"));
        }
    }
    if let Err(error) = swap.commit() {
        warnings.push(format!(
            "the temporary rollback file could not be removed: {error}"
        ));
    }
    let suffix = if warnings.is_empty() {
        String::new()
    } else {
        format!(" Restore completed, but {}.", warnings.join("; "))
    };
    best_effort(TimeDatabase::write_restore_notice(
        &path,
        RestoreNotice {
            ok: true,
            message: format!(
                "Restored {}. Safety backup: {}.{}",
                restored.source_name, restored.safety_backup_path, suffix
            ),
        },
    ));
    Ok(database)
}

#[cfg(test)]
mod tests {
    #[test]
    fn unreadable_marker_does_not_abandon_a_swapped_database() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target/test-scratch")
            .join(format!(
                "restore-marker-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&root).unwrap();
        let live = root.join("database.db");
        let database =
            tauri::async_runtime::block_on(crate::database::TimeDatabase::open(live.clone()))
                .unwrap();
        tauri::async_runtime::block_on(database.close());
        let previous = root.join("restore_previous.db");
        std::fs::copy(&live, &previous).unwrap();
        let marker = root.join("restore_pending.json");
        std::fs::write(&marker, b"incomplete marker").unwrap();
        assert!(super::open_database_with_pending_restore(live.clone()).is_err());
        assert!(marker.exists());
        assert!(previous.exists());
        assert!(live.exists());
    }

    #[test]
    fn a_migration_that_did_not_happen_names_the_tracker_log() {
        let database = std::path::Path::new(r"C:\Users\reader\AppData\Local\Time\Data\database.db");
        let error = "DatabaseSchemaTooOld: database schema 5 requires an explicit migration to 6";

        let silent = super::migration_failure(error, None, database);
        assert!(silent.starts_with(error), "{silent}");
        assert!(silent.contains("exited without migrating"), "{silent}");
        assert!(
            silent.ends_with(r"C:\Users\reader\AppData\Local\Time\Data\Logs\tracker.log"),
            "{silent}"
        );

        let failed = super::migration_failure(error, Some("Tracker could not migrate"), database);
        assert!(failed.contains("; Tracker could not migrate."), "{failed}");
        assert!(!failed.contains("exited without migrating"), "{failed}");
    }
}
