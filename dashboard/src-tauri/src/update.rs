//! The updater, Time's only network feature: one static-manifest check per
//! launch, and an install only when the reader asks for one.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::{database::database_path, install_id};

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

/// The anonymous install ID for this copy, or `None` when it cannot be read or
/// saved. See install_id.rs for why `None` is the safe answer.
fn current_install_id(app: &tauri::AppHandle) -> Option<String> {
    let base = app.path().local_data_dir().ok()?;
    install_id::load_or_create(&install_id::install_id_path(&database_path(&base))?)
}

/// Time's only automatic outbound request: a GET of a static version file,
/// carrying the anonymous install ID as a header so the website can count
/// returning installs. The URL stays constant, so nothing per-user lands in a
/// URL or a server log line. The check runs in Rust rather than through the
/// JavaScript plugin so the WebView never reaches the network and the
/// content-security policy stays shut.
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
pub async fn check_for_update(app: tauri::AppHandle) -> Option<AvailableUpdate> {
    run_update_check(&app).await.ok().flatten()
}

/// The same request, made because the reader pressed "Check for updates" in
/// Settings. Here the silence above would mislead: someone who asked has to be
/// told whether Time is current or simply could not reach the server, so a
/// failure comes back as an error instead of looking like "up to date".
#[tauri::command]
pub async fn check_for_update_now(
    app: tauri::AppHandle,
) -> Result<Option<AvailableUpdate>, String> {
    run_update_check(&app).await
}

async fn run_update_check(app: &tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let install_id = current_install_id(app);
    // Only presence is logged. The value would be harmless in a local file, but
    // a diagnostic people paste into bug reports is no place for it.
    let id_state = if install_id.is_some() {
        "present"
    } else {
        "absent"
    };
    let updater = match install_id {
        Some(id) => app
            .updater_builder()
            .header(install_id::INSTALL_ID_HEADER, id)
            .and_then(|builder| builder.build()),
        None => app.updater(),
    };
    let updater = match updater {
        Ok(updater) => updater,
        Err(error) => {
            log_update_check(
                app,
                &format!("install_id={id_state} outcome=unavailable error={error}"),
            );
            return Err(error.to_string());
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            log_update_check(
                app,
                &format!(
                    "install_id={id_state} outcome=available remote={}",
                    update.version
                ),
            );
            Ok(Some(AvailableUpdate {
                version: update.version.clone(),
                notes: update.body.clone(),
            }))
        }
        // The endpoint answered and offered nothing newer. Distinguishing this
        // from `failed` is most of the diagnostic value: one means the manifest
        // is stale or the build is older than it looks, the other means the
        // request never landed. The plugin discards the release on this path, so
        // the advertised version cannot be logged without a second request —
        // and a second request would break the "exactly one" claim in README.
        Ok(None) => {
            log_update_check(app, &format!("install_id={id_state} outcome=current"));
            Ok(None)
        }
        Err(error) => {
            log_update_check(
                app,
                &format!("install_id={id_state} outcome=failed error={error}"),
            );
            Err(error.to_string())
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
///
/// Deliberately the plain updater, without the install ID: the plugin copies
/// custom headers onto the installer download as well, and the ID's only job is
/// the check above. The website counts this fetch of the manifest as an
/// ID-less check, which is one extra in the legacy total per install.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
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
