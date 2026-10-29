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

use std::{
    path::PathBuf,
    process::{Child, Command, ExitStatus},
    time::{Duration, Instant},
};

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

/// Long enough for SQLite's 30 s busy timeout in the tracker, a pre-migration
/// backup of a large history, and a PyInstaller bundle unpacking itself on a
/// slow disk. This runs inside `setup()`, before any window exists.
const MIGRATION_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn run_tracker_migration() -> Result<(), String> {
    let path = tracker_path()?;
    if !path.is_file() {
        return Err(format!(
            "Packaged tracker was not found at {}; an older database cannot be migrated",
            path.display()
        ));
    }
    let mut command = Command::new(&path);
    command.current_dir(path.parent().ok_or("tracker path has no parent")?);
    command.env("TIME_MIGRATE_ONLY", "1");
    imp::hide_native_console(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let status = wait_with_timeout(&mut child, MIGRATION_TIMEOUT)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Tracker could not migrate the database (exit {status})"
        ))
    }
}

/// Wait for `child`, killing it if it outlives `timeout`.
///
/// `Command::status` waited forever, so a tracker stuck in its migration froze
/// the launch with no window to say so, and the process it left running held
/// the install directory's files open against every later installer.
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Result<ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            // Reap it as well, so nothing outlives this launch either way.
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Tracker did not finish migrating the database within {} seconds and was stopped",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn ping(count: &str) -> Child {
        Command::new("ping")
            .args(["-n", count, "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn ping")
    }

    #[test]
    fn a_process_that_exits_in_time_reports_its_status() {
        let mut child = ping("1");
        let status = wait_with_timeout(&mut child, Duration::from_secs(30)).unwrap();
        assert!(status.success());
    }

    #[test]
    fn a_process_that_outlives_the_timeout_is_stopped() {
        let mut child = ping("30");
        let started = Instant::now();
        let error = wait_with_timeout(&mut child, Duration::from_millis(500)).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        assert!(error.contains("was stopped"), "{error}");
        // Already reaped: a second wait returns at once rather than blocking.
        assert!(child.try_wait().unwrap().is_some());
    }
}
