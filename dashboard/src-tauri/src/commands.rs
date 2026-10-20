//! Every native command the dashboard can invoke: the whole IPC surface in one
//! place, so what the webview may ask the host to do is reviewable at once.
//!
//! Each is a thin wrapper. Database work lives in `database`, tracker and
//! startup side effects in `lifecycle`, and OS calls in `platform`; the updater's
//! two commands live with it in `update`. Tauri names a command after its
//! function, so moving one between modules never changes what the renderer
//! invokes. `generate_handler!` in lib.rs is the registration.

use std::{fs, path::PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::database::{
    database_path, ActivityDeletePreview, ActivityDeleteRequest, ActivityDeleteResult,
    DatabaseBackup, EntityRuleAssignment, EntityRuleChange, ExecuteResult, RestoreNotice,
    SessionClassificationRequest, SessionClassificationResult, SessionColumns, SessionCorrection,
    SessionCorrectionRequest, SettingUpdate, TimeDatabase, TrackingExclusion,
    TrackingExclusionPreview, TrackingExclusionResult,
};
use crate::lifecycle::{
    execute_tracking_lifecycle, prepare_restore_for_restart, LifecycleCoordinator, LifecycleResult,
    RealTrackingSystem, TrackingLifecycleAction,
};
use crate::platform;

/// Resolve the shared SQLite path (%LOCALAPPDATA%\Time\Data\database.db) and ensure
/// the directory exists. The tracker derives the same location in
/// tracker/config.py, so the two halves share one database.
#[tauri::command]
pub fn db_path(app: tauri::AppHandle) -> Result<String, String> {
    let base = app.path().local_data_dir().map_err(|e| e.to_string())?;
    let path = database_path(&base);
    fs::create_dir_all(path.parent().ok_or("database path has no parent")?)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn db_select(
    database: tauri::State<'_, TimeDatabase>,
    query: String,
    values: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    database.select(query, values).await
}

#[tauri::command]
pub async fn db_execute(
    database: tauri::State<'_, TimeDatabase>,
    query: String,
    values: Vec<serde_json::Value>,
) -> Result<ExecuteResult, String> {
    database.execute(query, values).await
}

#[tauri::command]
pub async fn update_user_settings(
    lifecycle: tauri::State<'_, LifecycleCoordinator>,
    database: tauri::State<'_, TimeDatabase>,
    updates: Vec<SettingUpdate>,
) -> Result<(), String> {
    let _guard = lifecycle.gate().lock().await;
    database.update_user_settings(&updates).await
}

#[tauri::command]
pub async fn run_tracking_lifecycle(
    lifecycle: tauri::State<'_, LifecycleCoordinator>,
    database: tauri::State<'_, TimeDatabase>,
    action: TrackingLifecycleAction,
) -> Result<LifecycleResult, String> {
    let _guard = lifecycle.gate().lock().await;
    execute_tracking_lifecycle(&database, action, &RealTrackingSystem).await
}

/// Whether Windows actually holds the startup registration, rather than what
/// the database says about it.
///
/// The stored setting is a wish; the Run value is the fact. Settings has always
/// rendered the wish, and that is what let a registration removed from outside
/// the application — the uninstaller an in-place upgrade runs first, a rebuilt
/// Windows profile — go on being reported as "on" over nothing at all.
///
/// `reconcile_startup_registration` repairs that at every launch and covers the
/// ordinary case. It is deliberately allowed to fail without stopping the
/// launch, though, so the two can still disagree — and the moment somebody is
/// looking at this switch is exactly when they should be told.
#[tauri::command]
pub fn startup_is_registered() -> Result<bool, String> {
    platform::startup_is_registered()
}

#[tauri::command]
pub async fn fetch_sessions(
    database: tauri::State<'_, TimeDatabase>,
    start_sec: f64,
    end_sec: f64,
) -> Result<SessionColumns, String> {
    database.fetch_sessions(start_sec, end_sec).await
}

#[tauri::command]
pub async fn backup_database(
    database: tauri::State<'_, TimeDatabase>,
    backup_name: String,
) -> Result<String, String> {
    database.backup_with_name(&backup_name).await
}

#[tauri::command]
pub async fn list_database_backups(
    database: tauri::State<'_, TimeDatabase>,
) -> Result<Vec<DatabaseBackup>, String> {
    database.list_backups().await
}

#[tauri::command]
pub async fn inspect_database_backup(
    database: tauri::State<'_, TimeDatabase>,
    backup_path: String,
) -> Result<DatabaseBackup, String> {
    database.inspect_backup(PathBuf::from(backup_path)).await
}

#[tauri::command]
pub fn choose_database_backup_file(
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
pub async fn restore_database(
    app: tauri::AppHandle,
    lifecycle: tauri::State<'_, LifecycleCoordinator>,
    database: tauri::State<'_, TimeDatabase>,
    backup_path: String,
) -> Result<(), String> {
    let _guard = lifecycle.gate().lock().await;
    prepare_restore_for_restart(&database, PathBuf::from(backup_path), &RealTrackingSystem).await?;
    app.restart()
}

#[tauri::command]
pub fn take_restore_notice(app: tauri::AppHandle) -> Result<Option<RestoreNotice>, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|error| error.to_string())?;
    TimeDatabase::take_restore_notice(&database_path(&base))
}

#[tauri::command]
pub async fn preview_activity_delete(
    database: tauri::State<'_, TimeDatabase>,
    request: ActivityDeleteRequest,
) -> Result<ActivityDeletePreview, String> {
    database.preview_activity_delete(&request).await
}

#[tauri::command]
pub async fn delete_activity(
    database: tauri::State<'_, TimeDatabase>,
    request: ActivityDeleteRequest,
) -> Result<ActivityDeleteResult, String> {
    database.delete_activity(&request).await
}

#[tauri::command]
pub async fn delete_history_before(
    database: tauri::State<'_, TimeDatabase>,
    cutoff_sec: f64,
) -> Result<u64, String> {
    database.delete_history_before(cutoff_sec).await
}

#[tauri::command]
pub async fn list_tracking_exclusions(
    database: tauri::State<'_, TimeDatabase>,
) -> Result<Vec<TrackingExclusion>, String> {
    database.list_tracking_exclusions().await
}

#[tauri::command]
pub async fn preview_tracking_exclusion(
    database: tauri::State<'_, TimeDatabase>,
    kind: String,
    pattern: String,
) -> Result<TrackingExclusionPreview, String> {
    database.preview_tracking_exclusion(&kind, &pattern).await
}

#[tauri::command]
pub async fn add_tracking_exclusion(
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
pub async fn remove_tracking_exclusion(
    database: tauri::State<'_, TimeDatabase>,
    kind: String,
    pattern: String,
) -> Result<u64, String> {
    database.remove_tracking_exclusion(&kind, &pattern).await
}

#[tauri::command]
pub async fn fetch_session_correction(
    database: tauri::State<'_, TimeDatabase>,
    session_id: i64,
) -> Result<SessionCorrection, String> {
    database.fetch_session_correction(session_id).await
}

#[tauri::command]
pub async fn assign_entity_rule(
    database: tauri::State<'_, TimeDatabase>,
    match_type: String,
    pattern: String,
    category_id: i64,
    priority: i64,
) -> Result<EntityRuleChange, String> {
    database
        .assign_entity_rule(&match_type, &pattern, category_id, priority)
        .await
}

#[tauri::command]
pub async fn assign_entity_rules(
    database: tauri::State<'_, TimeDatabase>,
    assignments: Vec<EntityRuleAssignment>,
) -> Result<Vec<EntityRuleChange>, String> {
    database.assign_entity_rules(assignments).await
}

#[tauri::command]
pub async fn undo_entity_rules(
    database: tauri::State<'_, TimeDatabase>,
    changes: Vec<EntityRuleChange>,
) -> Result<(), String> {
    database.undo_entity_rules(changes).await
}

#[tauri::command]
pub async fn correct_session(
    database: tauri::State<'_, TimeDatabase>,
    request: SessionCorrectionRequest,
) -> Result<SessionCorrection, String> {
    database.correct_session(&request).await
}

#[tauri::command]
pub async fn reset_session_correction(
    database: tauri::State<'_, TimeDatabase>,
    session_id: i64,
) -> Result<u64, String> {
    database.reset_session_correction(session_id).await
}

#[tauri::command]
pub async fn classify_sessions(
    database: tauri::State<'_, TimeDatabase>,
    request: SessionClassificationRequest,
) -> Result<SessionClassificationResult, String> {
    database.classify_sessions(&request).await
}

#[tauri::command]
pub fn save_activity_export(
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

/// Open Explorer on the folder holding the database, with the file selected.
/// Settings shows where the data lives this way rather than printing a path
/// most readers have no use for. The path is derived here, never taken from
/// the page, so the command can open nothing else.
#[tauri::command]
pub fn reveal_database(app: tauri::AppHandle) -> Result<(), String> {
    let base = app.path().local_data_dir().map_err(|e| e.to_string())?;
    platform::reveal_in_file_manager(&database_path(&base))
}

/// The ProgId Windows records as the handler for https — "ChromeHTML",
/// "FirefoxURL", "VivaldiHTM", and so on. Time uses it for exactly one thing:
/// choosing which extension store to offer during onboarding, so that the
/// listing opens in the browser that will install it.
///
/// Every failure collapses to `None`, matching `check_for_update`. A machine
/// with no UserChoice key, a policy-locked hive, or a ProgId Time has never
/// heard of is not a problem to report — the caller falls back to the store
/// that serves most browsers, and the reader can always decline.
#[tauri::command]
pub fn default_browser_prog_id() -> Option<String> {
    platform::default_browser_prog_id()
}
