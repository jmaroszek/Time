use std::fs;
use tauri::Manager;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod commands;
mod database;
mod install_id;
mod lifecycle;
mod platform;
mod restore;
mod update;
mod window_state;

fn saved_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

use database::database_path;
use lifecycle::{reconcile_startup_registration, LifecycleCoordinator, RealTrackingSystem};

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
                platform::style_window_frame(&window);
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
            let database = match restore::open_database_with_pending_restore(path) {
                Ok(database) => database,
                Err(error) => {
                    platform::report_fatal_launch_failure(&error);
                    return Err(std::io::Error::other(error).into());
                }
            };
            // Startup registration is removed by things the application never
            // sees -- the uninstaller an in-place upgrade runs first, a rebuilt
            // Windows profile -- while the database goes on reporting the
            // setting as on.  Repairing it here is deliberately not worth
            // refusing to start over: a failure leaves the state exactly as it
            // was found, which is the state every launch before this one
            // already ran in.
            let _ = tauri::async_runtime::block_on(reconcile_startup_registration(
                &database,
                &RealTrackingSystem,
            ));
            // Recorded before any window can ask to delete history, so the
            // early-beta marker never depends on activity that is later
            // deleted. The deletion paths record it again in case this one
            // failed; a failure here costs nothing until a paid release.
            let _ = tauri::async_runtime::block_on(database.record_early_beta());
            app.manage(database);
            app.manage(LifecycleCoordinator::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_path,
            commands::db_select,
            commands::db_execute,
            commands::update_user_settings,
            commands::run_tracking_lifecycle,
            commands::startup_is_registered,
            commands::fetch_sessions,
            commands::backup_database,
            commands::list_database_backups,
            commands::inspect_database_backup,
            commands::choose_database_backup_file,
            commands::restore_database,
            commands::take_restore_notice,
            commands::preview_activity_delete,
            commands::delete_activity,
            commands::delete_history_before,
            commands::list_tracking_exclusions,
            commands::preview_tracking_exclusion,
            commands::add_tracking_exclusion,
            commands::remove_tracking_exclusion,
            commands::fetch_session_correction,
            commands::correct_session,
            commands::assign_entity_rule,
            commands::assign_entity_rules,
            commands::undo_entity_rules,
            commands::reset_session_correction,
            commands::classify_sessions,
            commands::save_activity_export,
            commands::reveal_database,
            commands::default_browser_prog_id,
            update::check_for_update,
            update::check_for_update_now,
            update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
