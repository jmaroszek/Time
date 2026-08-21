use serde::Serialize;
use std::{fs, path::PathBuf, process::Command};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[cfg(windows)]
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
};
#[cfg(windows)]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

mod database;
mod lifecycle;
mod restore;
mod window_state;

fn saved_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

use database::{
    database_path, ActivityDeletePreview, ActivityDeleteRequest, ActivityDeleteResult,
    DatabaseBackup, ExecuteResult, RestoreNotice, SessionClassificationRequest,
    SessionClassificationResult, SessionColumns, SessionCorrection, SessionCorrectionRequest,
    SettingUpdate, TimeDatabase, TrackingExclusion, TrackingExclusionPreview,
    TrackingExclusionResult,
};
use lifecycle::{
    execute_tracking_lifecycle, prepare_restore_for_restart, LifecycleCoordinator, LifecycleResult,
    RealTrackingSystem, TrackingLifecycleAction,
};

#[cfg(windows)]
const fn colorref(red: u8, green: u8, blue: u8) -> u32 {
    red as u32 | ((green as u32) << 8) | ((blue as u32) << 16)
}

#[cfg(windows)]
fn style_windows_frame<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    // The undecorated window keeps DWM's shadow and rounded Windows 11 frame.
    // Darkening its system border prevents that retained frame from becoming a
    // bright seam around Time's otherwise continuous background.
    let dark_mode = 1i32;
    let border_color = colorref(0x2a, 0x2e, 0x36);
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&dark_mode).cast(),
            std::mem::size_of_val(&dark_mode) as u32,
        );
        // Custom border colors were added in Windows 11. Ignore an unsupported
        // result so older Windows versions retain their native shadow frame.
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::from_ref(&border_color).cast(),
            std::mem::size_of_val(&border_color) as u32,
        );
    }
}

/// Resolve the shared SQLite path (%LOCALAPPDATA%\Time\Data\database.db) and ensure
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
async fn update_user_settings(
    lifecycle: tauri::State<'_, LifecycleCoordinator>,
    database: tauri::State<'_, TimeDatabase>,
    updates: Vec<SettingUpdate>,
) -> Result<(), String> {
    let _guard = lifecycle.gate().lock().await;
    database.update_user_settings(&updates).await
}

#[tauri::command]
async fn run_tracking_lifecycle(
    lifecycle: tauri::State<'_, LifecycleCoordinator>,
    database: tauri::State<'_, TimeDatabase>,
    action: TrackingLifecycleAction,
) -> Result<LifecycleResult, String> {
    let _guard = lifecycle.gate().lock().await;
    execute_tracking_lifecycle(&database, action, &RealTrackingSystem).await
}

#[tauri::command]
async fn fetch_sessions(
    database: tauri::State<'_, TimeDatabase>,
    start_sec: f64,
    end_sec: f64,
) -> Result<SessionColumns, String> {
    database.fetch_sessions(start_sec, end_sec).await
}

#[tauri::command]
async fn backup_database(
    database: tauri::State<'_, TimeDatabase>,
    backup_name: String,
) -> Result<String, String> {
    database.backup_with_name(&backup_name).await
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
    lifecycle: tauri::State<'_, LifecycleCoordinator>,
    database: tauri::State<'_, TimeDatabase>,
    backup_path: String,
) -> Result<(), String> {
    let _guard = lifecycle.gate().lock().await;
    prepare_restore_for_restart(&database, PathBuf::from(backup_path), &RealTrackingSystem).await?;
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
async fn classify_sessions(
    database: tauri::State<'_, TimeDatabase>,
    request: SessionClassificationRequest,
) -> Result<SessionClassificationResult, String> {
    database.classify_sessions(&request).await
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

pub(crate) fn system_start_tracker() -> Result<(), String> {
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

pub(crate) fn system_stop_tracker() -> Result<(), String> {
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

pub(crate) fn system_set_launch_at_login(enabled: bool) -> Result<(), String> {
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

fn system_run_tracker_migration() -> Result<(), String> {
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

pub(crate) fn system_tracker_is_running() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq time-tracker.exe", "/NH"])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Could not query tracker status ({})",
                output.status
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
        return Ok(text.contains("time-tracker.exe"));
    }
    #[cfg(not(windows))]
    Ok(false)
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
fn default_browser_prog_id() -> Option<String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        return hkcu
            .open_subkey(
                "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
            )
            .ok()?
            .get_value::<String, _>("ProgId")
            .ok();
    }
    #[cfg(not(windows))]
    None
}

/// Progress channel for the one long operation Time performs over the network.
/// The installer is the whole application, so a bare spinner would sit there for
/// tens of seconds with nothing to say.
const UPDATE_PROGRESS_EVENT: &str = "update://progress";

#[derive(Clone, Debug, Serialize)]
pub struct AvailableUpdate {
    version: String,
    /// Release notes as published in the update manifest, when it carries any.
    notes: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct UpdateProgress {
    downloaded: usize,
    /// Absent until the endpoint declares a length; the control shows an
    /// indeterminate bar rather than inventing a denominator.
    total: Option<u64>,
}

/// Names a file the update check appends one line to. Unset — which is every
/// real installation — and nothing is written anywhere.
const UPDATE_LOG_ENV: &str = "TIME_UPDATE_LOG";

/// The log file, or `None` when the variable is absent or blank.
///
/// Split out from the writing so the property that matters can be tested: no
/// file is created unless somebody explicitly asked for one by name.
fn update_log_path() -> Option<PathBuf> {
    let value = std::env::var(UPDATE_LOG_ENV).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Opt-in diagnostic for the one code path with no other way to observe it.
///
/// `check_for_update` reports nothing on purpose (see below), which is right for
/// users and expensive for testing: an unreachable host, a stale manifest, an
/// installer built against the wrong endpoint, and an app that is genuinely
/// up to date all present as the same silence. Telling them apart otherwise
/// means reading strings out of the installed binary — which is exactly what
/// the August 2026 update rehearsal had to do, twice.
///
/// Gated on an environment variable rather than `debug_assertions`, because what
/// gets tested is a release installer; a debug-only line would never run where
/// the question actually gets asked.
///
/// Nothing user-identifying can reach the file. The endpoint is a compile-time
/// constant, the version is a build constant, and the outcome text comes from
/// the updater. No path, hostname, or window title of the user's is involved.
fn log_update_check(app: &tauri::AppHandle, outcome: &str) {
    let Some(path) = update_log_path() else {
        return;
    };
    // The endpoint is the field worth having: a build that checks the wrong URL
    // is indistinguishable from a working one until this line names it.
    let endpoints = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .map(|value| value.to_string())
        .unwrap_or_else(|| "<none configured>".to_owned());
    let line = format!(
        "{} version={} endpoints={} {}\n",
        chrono::Local::now().to_rfc3339(),
        app.package_info().version,
        endpoints,
        outcome,
    );
    // A diagnostic that can fail the thing it observes would be worse than none.
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

/// Time's only outbound request: an unconditional GET of a static version file.
/// The check runs in Rust rather than through the JavaScript plugin so the
/// WebView never reaches the network and the content-security policy stays shut.
///
/// Every failure collapses to `None`. A check that cannot reach the endpoint is
/// a non-event — offline, asleep, DNS, a hotel captive portal — and reporting it
/// would turn the one network call Time makes into a recurring alarm about a
/// machine that is working perfectly.
///
/// The arms are spelled out rather than collapsed into a `?` chain so that
/// `log_update_check` can name which one was taken. The return value is
/// unchanged: still `None` for every outcome that is not an available update.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Option<AvailableUpdate> {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            log_update_check(&app, &format!("outcome=unavailable error={error}"));
            return None;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            log_update_check(
                &app,
                &format!("outcome=available remote={}", update.version),
            );
            Some(AvailableUpdate {
                version: update.version.clone(),
                notes: update.body.clone(),
            })
        }
        // The endpoint answered and offered nothing newer. Distinguishing this
        // from `failed` is most of the diagnostic value: one means the manifest
        // is stale or the build is older than it looks, the other means the
        // request never landed. The plugin discards the release on this path, so
        // the advertised version cannot be logged without a second request —
        // and a second request would break the "exactly one" claim in README.
        Ok(None) => {
            log_update_check(&app, "outcome=current");
            None
        }
        Err(error) => {
            log_update_check(&app, &format!("outcome=failed error={error}"));
            None
        }
    }
}

/// Downloads the new installer and runs it. Never called on a timer: installing
/// stops the sidecar and takes the window away, which a tool whose value is
/// continuous recording must not do unasked.
///
/// The NSIS package handles both halves by itself — the pre-install hook stops
/// the tracker, and the post-install hook starts it again, so recording resumes
/// without help. Windows exits this process during the install step, which is
/// why nothing here restarts the app.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Err("Time is already up to date.".into());
    };
    let mut downloaded = 0usize;
    let reporter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let _ = reporter.emit(UPDATE_PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// How long the window may stay hidden while the frontend loads. Generous:
/// this is a last resort, not a race with a cold start.
const FRONTEND_SHOW_DEADLINE: std::time::Duration = std::time::Duration::from_secs(12);

/// Show the window even if the frontend never mounts.
///
/// The window is created hidden and `WindowTitleBar` shows it, which keeps
/// visibility an application decision rather than a persisted window-state
/// field. The cost is that a webview which never loads leaves a process with no
/// window at all: alive, holding the database, holding the single-instance
/// lock, and invisible. Restoring a backup is where that bites, because the
/// restart puts a fresh startup between the user and their data — a failure
/// there reads as a crash, and the restore notice waiting to be shown is never
/// read.
///
/// Showing an unpainted window is not a good outcome. It is a far better one
/// than a process the user can neither see nor replace, and the native frame
/// goes back on so there is a close button when the frontend that draws Time's
/// own titlebar is the thing that failed.
fn show_window_if_the_frontend_never_does(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FRONTEND_SHOW_DEADLINE);
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if window.is_visible().unwrap_or(true) {
            return;
        }
        let _ = window.set_decorations(true);
        let _ = window.show();
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Register first: a second dashboard launch is an activation request,
        // not another database-owning window or process.
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility, decorations, and fullscreen are application
                // policy rather than user layout. Saving only these three
                // fields also prevents an interrupted startup from persisting
                // the intentionally hidden pre-restore window.
                .with_state_flags(saved_window_state_flags())
                .build(),
        )
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                style_windows_frame(&window);
                // The window-state plugin has already restored while the
                // window is hidden. Validate the result before React shows it.
                window_state::validate_restored_window(&window)?;

                // Persist while the native window still exists. The plugin
                // also saves on RunEvent::Exit, but automation and some
                // Windows shutdown paths can tear down the WebView session
                // before that final event reaches the application.
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        let _ = app_handle.save_window_state(saved_window_state_flags());
                    }
                });

                show_window_if_the_frontend_never_does(app.handle().clone());
            }

            let base = app.path().local_data_dir()?;
            let path = database_path(&base);
            fs::create_dir_all(path.parent().expect("database path parent"))?;
            let database =
                restore::open_database_with_pending_restore(path).map_err(std::io::Error::other)?;
            app.manage(database);
            app.manage(LifecycleCoordinator::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_path,
            db_select,
            db_execute,
            update_user_settings,
            run_tracking_lifecycle,
            fetch_sessions,
            backup_database,
            list_database_backups,
            inspect_database_backup,
            choose_database_backup_file,
            restore_database,
            take_restore_notice,
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
            classify_sessions,
            save_activity_export,
            default_browser_prog_id,
            check_for_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{update_log_path, UPDATE_LOG_ENV};

    /// The suite is serialized by RUST_TEST_THREADS in the repository's
    /// .cargo/config.toml, so mutating a process-wide variable here is safe.
    fn with_env<T>(value: Option<&str>, body: impl FnOnce() -> T) -> T {
        let previous = std::env::var(UPDATE_LOG_ENV).ok();
        match value {
            Some(value) => std::env::set_var(UPDATE_LOG_ENV, value),
            None => std::env::remove_var(UPDATE_LOG_ENV),
        }
        let result = body();
        match previous {
            Some(previous) => std::env::set_var(UPDATE_LOG_ENV, previous),
            None => std::env::remove_var(UPDATE_LOG_ENV),
        }
        result
    }

    #[test]
    fn no_log_file_without_the_variable() {
        // The property worth protecting: a normal installation writes nothing,
        // so the diagnostic can never become a file nobody asked for.
        assert!(with_env(None, update_log_path).is_none());
    }

    #[test]
    fn blank_values_do_not_name_a_file() {
        // PowerShell drops an environment variable set to "", but a value of
        // spaces survives and would otherwise be treated as a relative path,
        // creating a file named after nothing in the working directory.
        assert!(with_env(Some(""), update_log_path).is_none());
        assert!(with_env(Some("   "), update_log_path).is_none());
    }

    #[test]
    fn a_named_path_is_used_verbatim_once_trimmed() {
        // Trimmed because a path pasted into a shell picks up trailing spaces
        // far more often than a real path ends in one.
        let path = with_env(Some(r"  C:\Temp\time-update.log  "), update_log_path);
        assert_eq!(path.unwrap().to_string_lossy(), r"C:\Temp\time-update.log");
    }
}
