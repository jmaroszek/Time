//! Every target Time does not ship on: the functions `windows.rs` provides,
//! each refusing honestly, so the crate still builds there and a port starts
//! from the complete list of what it has to supply.
//!
//! These are the `#[cfg(not(windows))]` arms the functions carried before they
//! moved here, unchanged — including the tracker's Windows file name, which a
//! port replaces with its own.

use std::{path::Path, process::Command};

pub(super) const TRACKER_EXECUTABLE: &str = "time-tracker.exe";

pub(super) fn hide_native_console(_command: &mut Command) {}

pub(crate) fn stop_tracker() -> Result<(), String> {
    Err("Stopping the tracker is supported only on Windows".into())
}

pub(crate) fn tracker_is_running() -> Result<bool, String> {
    Ok(false)
}

pub(crate) fn set_launch_at_login(_enabled: bool) -> Result<(), String> {
    Err("Start at login is supported only on Windows".into())
}

pub(crate) fn startup_is_registered() -> Result<bool, String> {
    Err("Start at login is supported only on Windows".into())
}

pub(crate) fn default_browser_prog_id() -> Option<String> {
    None
}

pub(crate) fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let mut command = Command::new("explorer.exe");
    command.arg(path.parent().unwrap_or(path));
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn report_fatal_launch_failure(_error: &str) {}
