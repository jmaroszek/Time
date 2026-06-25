use std::fs;
use tauri::Manager;

/// Resolve the shared SQLite path (%LOCALAPPDATA%\Time\time_log.db) and ensure
/// the directory exists. The tracker derives the same location in
/// tracker/config.py, so the two halves share one database.
#[tauri::command]
fn db_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .local_data_dir()
        .map_err(|e| e.to_string())?
        .join("Time");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("time_log.db").to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![db_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
