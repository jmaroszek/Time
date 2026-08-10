use std::path::PathBuf;

use crate::database::{RestoreNotice, TimeDatabase, SCHEMA_VERSION};
use crate::{system_run_tracker_migration, system_set_launch_at_login, system_start_tracker};

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
            TimeDatabase::discard_pending_restore(&path, message)?;
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
            TimeDatabase::write_restore_notice(&path, RestoreNotice { ok: false, message })?;
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
    TimeDatabase::write_restore_notice(
        &path,
        RestoreNotice {
            ok: true,
            message: format!(
                "Restored {}. Safety backup: {}.{}",
                restored.source_name, restored.safety_backup_path, suffix
            ),
        },
    )?;
    Ok(database)
}
