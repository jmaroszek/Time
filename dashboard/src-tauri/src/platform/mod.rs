//! Everything Time asks of the operating system.
//!
//! The rest of the crate calls these functions and never branches on the OS
//! itself. Each OS is one file exporting the same set, and this module picks it
//! at compile time:
//!
//! - tracker process control: `stop_tracker` and `tracker_is_running`, plus the
//!   executable name and console handling that `start_tracker` and
//!   `run_tracker_migration` below share;
//! - start at login: `set_launch_at_login` and `startup_is_registered`;
//! - desktop integration: `default_browser_prog_id`, `reveal_in_file_manager`,
//!   `report_fatal_launch_failure`, and on Windows `style_window_frame`.
//!
//! `windows.rs` is the only implementation that ships. `unsupported.rs` is what
//! every other target gets: the same signatures, refusing honestly, so the crate
//! still builds there and a port starts from the complete list.

use std::{path::PathBuf, process::Command};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as imp;

// Also compiled into Windows test builds, so the fallbacks cannot rot unseen on
// a CI that only runs Windows.
#[cfg(any(not(windows), test))]
#[cfg_attr(windows, allow(dead_code))]
mod unsupported;
#[cfg(not(windows))]
use self::unsupported as imp;

#[cfg(windows)]
pub(crate) use imp::style_window_frame;
pub(crate) use imp::{
    default_browser_prog_id, report_fatal_launch_failure, reveal_in_file_manager,
    set_launch_at_login, startup_is_registered, stop_tracker, tracker_is_running,
};

fn tracker_path() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|dir| dir.join(imp::TRACKER_EXECUTABLE))
        .ok_or_else(|| "Time executable has no parent directory".into())
}

pub(crate) fn start_tracker() -> Result<(), String> {
    let path = tracker_path()?;
    if !path.is_file() {
        return Err(format!(
            "Packaged tracker was not found at {}",
            path.display()
        ));
    }
    let mut command = Command::new(&path);
    command.current_dir(path.parent().ok_or("tracker path has no parent")?);
    imp::hide_native_console(&mut command);
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn run_tracker_migration() -> Result<(), String> {
    let path = tracker_path()?;
    if !path.is_file() {
        return Err(format!(
            "Packaged tracker was not found at {}; an older backup cannot be migrated",
            path.display()
        ));
    }
    let mut command = Command::new(&path);
    command.current_dir(path.parent().ok_or("tracker path has no parent")?);
    command.env("TIME_MIGRATE_ONLY", "1");
    imp::hide_native_console(&mut command);
    let status = command.status().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Tracker could not migrate the restored database (exit {status})"
        ))
    }
}
