use std::{fs, path::PathBuf, process::Command};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

mod database;

use database::{
    database_path, ActivityDeletePreview, ActivityDeleteRequest, ActivityDeleteResult,
    ExecuteResult, SessionColumns, SessionCorrection, SessionCorrectionRequest, TimeDatabase,
    TrackingExclusion, TrackingExclusionPreview, TrackingExclusionResult,
};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let base = app.path().local_data_dir()?;
            let path = database_path(&base);
            fs::create_dir_all(path.parent().expect("database path parent"))?;
            let database = tauri::async_runtime::block_on(TimeDatabase::open(path))
                .map_err(std::io::Error::other)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_path,
            db_select,
            db_execute,
            fetch_sessions,
            backup_database,
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
