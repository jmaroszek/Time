use std::{fs, path::PathBuf, process::Command};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
};
#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

mod database;

use database::{
    database_path, ActivityDeletePreview, ActivityDeleteRequest, ActivityDeleteResult,
    DatabaseBackup, ExecuteResult, RestoreNotice, SessionColumns, SessionCorrection,
    SessionCorrectionRequest, TimeDatabase, TrackingExclusion, TrackingExclusionPreview,
    TrackingExclusionResult, SCHEMA_VERSION,
};

#[cfg(windows)]
const fn colorref(red: u8, green: u8, blue: u8) -> u32 {
    red as u32 | ((green as u32) << 8) | ((blue as u32) << 16)
}

#[cfg(windows)]
fn style_windows_title_bar<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    // These mirror --color-bg and --color-ink-3 in dashboard/src/index.css.
    // Keeping the system-drawn frame preserves Windows snap, menu, and caption
    // behavior while making that frame part of Time's existing visual canvas.
    let dark_mode = 1i32;
    let caption_color = colorref(0x0f, 0x11, 0x15);
    let text_color = colorref(0x79, 0x80, 0x8d);
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&dark_mode).cast(),
            std::mem::size_of_val(&dark_mode) as u32,
        );
        // Custom caption and text colors were added in Windows 11. Ignore an
        // unsupported result so Windows 10 keeps its native dark title bar.
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            std::ptr::from_ref(&caption_color).cast(),
            std::mem::size_of_val(&caption_color) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR,
            std::ptr::from_ref(&text_color).cast(),
            std::mem::size_of_val(&text_color) as u32,
        );
    }
}

/// Resolve the shared SQLite path (%LOCALAPPDATA%\Time\time_log.db) and ensure
/// the directory exists. The tracker derives the same location in
/// tracker/config.py, so the two halves share one database.
#[tauri::command]
fn db_path(app: tauri::AppHandle) -> Result<String, String> {
    let base = app.path().local_data_dir().map_err(|e| e.to_string())?;
    let path = database_path(&base);
    fs::create_dir_all(path.parent().ok_or("database path has no parent")?)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn db_select(
    database: tauri::State<'_, TimeDatabase>,
    query: String,
    values: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    database.select(query, values).await
}

#[tauri::command]
async fn db_execute(
    database: tauri::State<'_, TimeDatabase>,
    query: String,
    values: Vec<serde_json::Value>,
) -> Result<ExecuteResult, String> {
    database.execute(query, values).await
}

#[tauri::command]
async fn fetch_sessions(
    database: tauri::State<'_, TimeDatabase>,
    start_sec: f64,
    end_sec: f64,
    min_start_sec: f64,
) -> Result<SessionColumns, String> {
    database
        .fetch_sessions(start_sec, end_sec, min_start_sec)
        .await
}

#[tauri::command]
async fn backup_database(database: tauri::State<'_, TimeDatabase>) -> Result<String, String> {
    database.backup().await
}

#[tauri::command]
async fn list_database_backups(
    database: tauri::State<'_, TimeDatabase>,
) -> Result<Vec<DatabaseBackup>, String> {
    database.list_backups().await
}

#[tauri::command]
async fn inspect_database_backup(
    database: tauri::State<'_, TimeDatabase>,
    backup_path: String,
) -> Result<DatabaseBackup, String> {
    database.inspect_backup(PathBuf::from(backup_path)).await
}

#[tauri::command]
fn choose_database_backup_file(
    app: tauri::AppHandle,
    database: tauri::State<'_, TimeDatabase>,
) -> Result<Option<String>, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .set_directory(database.backups_dir()?)
        .add_filter("SQLite database", &["db"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn restore_database(
    app: tauri::AppHandle,
    database: tauri::State<'_, TimeDatabase>,
    backup_path: String,
) -> Result<(), String> {
    let tracker_was_enabled = database.recording_consent().await?;
    let mut pending = database.prepare_restore(PathBuf::from(backup_path)).await?;
    if let Err(error) = stop_tracker() {
        database.cancel_pending_restore()?;
        return Err(error);
    }
    if let Err(error) = database.refresh_pending_safety_backup(&mut pending).await {
        database.cancel_pending_restore()?;
        if tracker_was_enabled {
            let _ = start_tracker();
        }
        return Err(error);
    }
    app.restart()
}

#[tauri::command]
fn take_restore_notice(app: tauri::AppHandle) -> Result<Option<RestoreNotice>, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|error| error.to_string())?;
    TimeDatabase::take_restore_notice(&database_path(&base))
}

#[tauri::command]
async fn erase_history(database: tauri::State<'_, TimeDatabase>) -> Result<u64, String> {
    database.erase_history().await
}

#[tauri::command]
async fn preview_activity_delete(
    database: tauri::State<'_, TimeDatabase>,
    request: ActivityDeleteRequest,
) -> Result<ActivityDeletePreview, String> {
    database.preview_activity_delete(&request).await
}

#[tauri::command]
async fn delete_activity(
    database: tauri::State<'_, TimeDatabase>,
    request: ActivityDeleteRequest,
) -> Result<ActivityDeleteResult, String> {
    database.delete_activity(&request).await
}

#[tauri::command]
async fn delete_history_before(
    database: tauri::State<'_, TimeDatabase>,
    cutoff_sec: f64,
) -> Result<u64, String> {
    database.delete_history_before(cutoff_sec).await
}

#[tauri::command]
async fn list_tracking_exclusions(
    database: tauri::State<'_, TimeDatabase>,
) -> Result<Vec<TrackingExclusion>, String> {
    database.list_tracking_exclusions().await
}

#[tauri::command]
async fn preview_tracking_exclusion(
    database: tauri::State<'_, TimeDatabase>,
    kind: String,
    pattern: String,
) -> Result<TrackingExclusionPreview, String> {
    database.preview_tracking_exclusion(&kind, &pattern).await
}

#[tauri::command]
async fn add_tracking_exclusion(
    database: tauri::State<'_, TimeDatabase>,
    kind: String,
    pattern: String,
    delete_history: bool,
) -> Result<TrackingExclusionResult, String> {
    database
        .add_tracking_exclusion(&kind, &pattern, delete_history)
        .await
}

#[tauri::command]
async fn remove_tracking_exclusion(
    database: tauri::State<'_, TimeDatabase>,
    kind: String,
    pattern: String,
) -> Result<u64, String> {
    database.remove_tracking_exclusion(&kind, &pattern).await
}

#[tauri::command]
async fn fetch_session_correction(
    database: tauri::State<'_, TimeDatabase>,
    session_id: i64,
) -> Result<SessionCorrection, String> {
    database.fetch_session_correction(session_id).await
}

#[tauri::command]
async fn correct_session(
    database: tauri::State<'_, TimeDatabase>,
    request: SessionCorrectionRequest,
) -> Result<SessionCorrection, String> {
    database.correct_session(&request).await
}

#[tauri::command]
async fn reset_session_correction(
    database: tauri::State<'_, TimeDatabase>,
    session_id: i64,
) -> Result<u64, String> {
    database.reset_session_correction(session_id).await
}

#[tauri::command]
fn save_activity_export(
    app: tauri::AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    if contents.len() > 256 * 1024 * 1024 {
        return Err("Export is too large to write safely".into());
    }
    let name = suggested_name.trim();
    if name.is_empty()
        || name.len() > 180
        || name.contains('/')
        || name.contains('\\')
        || !name.to_ascii_lowercase().ends_with(".csv")
    {
        return Err("Invalid export filename".into());
    }
    let Some(file_path) = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter("CSV", &["csv"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|error| error.to_string())?;
    fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn tracker_path() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|dir| dir.join("time-tracker.exe"))
        .ok_or_else(|| "Time executable has no parent directory".into())
}

#[tauri::command]
fn start_tracker() -> Result<(), String> {
    let path = tracker_path()?;
    if !path.is_file() {
        return Err(format!(
            "Packaged tracker was not found at {}",
            path.display()
        ));
    }
    Command::new(&path)
        .current_dir(path.parent().ok_or("tracker path has no parent")?)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn stop_tracker() -> Result<(), String> {
    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/IM", "time-tracker.exe", "/T", "/F"])
            .status()
            .map_err(|e| e.to_string())?;
        // taskkill returns 128 when no matching process exists; both states are
        // safe for a privacy erase because no tracker can write afterward.
        if status.success() || status.code() == Some(128) {
            return Ok(());
        }
        return Err(format!("Could not stop tracker (taskkill exit {status})"));
    }
    #[cfg(not(windows))]
    Err("Stopping the tracker is supported only on Windows".into())
}

#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    set_launch_at_login_impl(enabled)
}

fn set_launch_at_login_impl(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu
            .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .map_err(|e| e.to_string())?;
        if enabled {
            let path = tracker_path()?;
            if !path.is_file() {
                return Err(format!(
                    "Packaged tracker was not found at {}",
                    path.display()
                ));
            }
            run.set_value("Time Tracker", &format!("\"{}\"", path.display()))
                .map_err(|e| e.to_string())?;
        } else {
            match run.delete_value("Time Tracker") {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Start at login is supported only on Windows".into())
    }
}

fn run_tracker_migration() -> Result<(), String> {
    let path = tracker_path()?;
    if !path.is_file() {
        return Err(format!(
            "Packaged tracker was not found at {}; an older backup cannot be migrated",
            path.display()
        ));
    }
    let status = Command::new(&path)
        .current_dir(path.parent().ok_or("tracker path has no parent")?)
        .env("TIME_MIGRATE_ONLY", "1")
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Tracker could not migrate the restored database (exit {status})"
        ))
    }
}

fn open_database_with_pending_restore(path: PathBuf) -> Result<TimeDatabase, String> {
    let pending = tauri::async_runtime::block_on(TimeDatabase::begin_pending_restore(&path));
    let swap = match pending {
        Ok(Some(swap)) => swap,
        Ok(None) => return tauri::async_runtime::block_on(TimeDatabase::open(path)),
        Err(error) => {
            let message = format!("Restore was canceled before replacement: {error}");
            TimeDatabase::discard_pending_restore(&path, message)?;
            return tauri::async_runtime::block_on(TimeDatabase::open(path));
        }
    };
    let restored = swap.pending.clone();
    let opened = (|| {
        if restored.schema_version < SCHEMA_VERSION {
            run_tracker_migration()?;
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
        set_launch_at_login_impl(restored.recording_consent && restored.launch_at_login)
    {
        warnings.push(format!("Windows startup could not be updated: {error}"));
    }
    if restored.recording_consent {
        if let Err(error) = start_tracker() {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                style_windows_title_bar(&window);
            }

            let base = app.path().local_data_dir()?;
            let path = database_path(&base);
            fs::create_dir_all(path.parent().expect("database path parent"))?;
            let database =
                open_database_with_pending_restore(path).map_err(std::io::Error::other)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_path,
            db_select,
            db_execute,
            fetch_sessions,
            backup_database,
            list_database_backups,
            inspect_database_backup,
            choose_database_backup_file,
            restore_database,
            take_restore_notice,
            erase_history,
            preview_activity_delete,
            delete_activity,
            delete_history_before,
            list_tracking_exclusions,
            preview_tracking_exclusion,
            add_tracking_exclusion,
            remove_tracking_exclusion,
            fetch_session_correction,
            correct_session,
            reset_session_correction,
            save_activity_export,
            start_tracker,
            stop_tracker,
            set_launch_at_login
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
