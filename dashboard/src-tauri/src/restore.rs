use std::path::PathBuf;

use crate::database::{RestoreNotice, TimeDatabase, SCHEMA_VERSION};
use crate::{system_run_tracker_migration, system_set_launch_at_login, system_start_tracker};

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
        Ok(None) => return tauri::async_runtime::block_on(TimeDatabase::open(path)),
        Err(error) => {
            // Keep the marker if the database vanished partway through the
            // swap: the next launch needs it to put the rollback copy back.
            if !path.exists() {
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
            return tauri::async_runtime::block_on(TimeDatabase::open(path));
        }
    };
    let restored = swap.pending.clone();
    let opened = (|| {
        if restored.schema_version < SCHEMA_VERSION {
            system_run_tracker_migration()?;
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
            return tauri::async_runtime::block_on(TimeDatabase::open(path));
        }
    };

    let mut warnings = Vec::new();
    if let Err(error) =
        system_set_launch_at_login(restored.recording_consent && restored.launch_at_login)
    {
        warnings.push(format!("Windows startup could not be updated: {error}"));
    }
    if restored.recording_consent {
        if let Err(error) = system_start_tracker() {
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
