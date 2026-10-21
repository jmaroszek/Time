//! Windows, the platform Time ships on.

use std::{path::Path, process::Command};

use ::windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use super::tracker_path;

/// The packaged tracker, installed beside Time.exe.
pub(super) const TRACKER_EXECUTABLE: &str = "time-tracker.exe";

/// Keep native children invisible when launched from the GUI host. Windows
/// console utilities such as `tasklist` and `taskkill` otherwise briefly open
/// a terminal during lifecycle actions; applying the flag to every child also
/// keeps this invariant intact if the packaged tracker's subsystem changes.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) fn hide_native_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

pub(crate) fn stop_tracker() -> Result<(), String> {
    stop_trackers_at(&tracker_path()?)
}

pub(crate) fn tracker_is_running() -> Result<bool, String> {
    Ok(!tracker_pids_at(&tracker_path()?)?.is_empty())
}

fn stop_trackers_at(path: &Path) -> Result<(), String> {
    let pids = tracker_pids_at(path)?;
    if pids.is_empty() {
        return Ok(());
    }
    let mut command = Command::new("taskkill");
    for pid in &pids {
        command.args(["/PID", &pid.to_string()]);
    }
    command.args(["/T", "/F"]);
    hide_native_console(&mut command);
    let status = command.status().map_err(|e| e.to_string())?;
    // taskkill returns 128 when a listed process has already exited; both
    // states are safe for a privacy erase because no tracker can write
    // afterward.
    if status.success() || status.code() == Some(128) {
        return Ok(());
    }
    Err(format!("Could not stop tracker (taskkill exit {status})"))
}

/// The running trackers launched from exactly `path`.
///
/// Matched by full path rather than by image name. Every Time build names its
/// tracker the same, so a name match let a `tauri dev` build that turned
/// recording off end the installed tracker too, which then recorded nothing
/// until something relaunched it and said nothing on screen about it.
fn tracker_pids_at(path: &Path) -> Result<Vec<u32>, String> {
    use ::windows::Win32::Foundation::CloseHandle;
    use ::windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let wanted = comparable_path(path);
    // SAFETY: the snapshot handle is closed below on every path, and the entry
    // is initialised with the size the API requires before the first call.
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut pids = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            // The name filter only saves opening every process on the machine;
            // the path comparison is what decides.
            if name.eq_ignore_ascii_case(TRACKER_EXECUTABLE)
                && process_image_path(entry.th32ProcessID)
                    .is_some_and(|image| comparable_path(&image) == wanted)
            {
                pids.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        Ok(pids)
    }
}

/// A process's executable, or `None` once it has exited or cannot be opened.
fn process_image_path(pid: u32) -> Option<std::path::PathBuf> {
    use ::windows::core::PWSTR;
    use ::windows::Win32::Foundation::CloseHandle;
    use ::windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: the buffer outlives the call and its length is passed with it;
    // the process handle is closed before returning.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 32_768];
        let mut length = buffer.len() as u32;
        let queried = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        );
        let _ = CloseHandle(process);
        queried.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]).into())
    }
}

/// Windows paths compare without regard to case, and one spelling may carry
/// the `\\?\` prefix that canonicalising adds.
fn comparable_path(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

/// Where Windows startup registration lives, and under what name.
///
/// `dashboard/src-tauri/windows/installer-hooks.nsh` names the same key and the
/// same value, so that the uninstaller can remove the registration Time made.
/// Neither side can observe the other's spelling, so a change to one is only
/// ever correct alongside the same change to the other.
const STARTUP_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_RUN_VALUE: &str = "Time Tracker";

/// The Run value this installation writes: the packaged tracker's path, quoted
/// the way Windows expects a command that may contain spaces.
fn startup_command() -> Result<String, String> {
    let path = tracker_path()?;
    if !path.is_file() {
        return Err(format!(
            "Packaged tracker was not found at {}",
            path.display()
        ));
    }
    Ok(quoted_command(&path))
}

fn quoted_command(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

pub(crate) fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu
        .create_subkey(STARTUP_RUN_KEY)
        .map_err(|e| e.to_string())?;
    if enabled {
        run.set_value(STARTUP_RUN_VALUE, &startup_command()?)
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        // Not `startup_command`: turning startup off must not depend on the
        // tracker still being on disk.
        remove_startup_value(&run, &quoted_command(&tracker_path()?))
    }
}

/// Delete the Run value only when it starts this build's own tracker.
///
/// Every Time build shares the one value name, so deleting unconditionally let
/// a `tauri dev` build that turned recording off remove the installed app's
/// registration, and the installed tracker stopped starting at sign-in. A value
/// naming another path is some other installation's choice and is left alone.
fn remove_startup_value(run: &RegKey, own_command: &str) -> Result<(), String> {
    let registered: String = match run.get_value(STARTUP_RUN_VALUE) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !registered.eq_ignore_ascii_case(own_command) {
        return Ok(());
    }
    match run.delete_value(STARTUP_RUN_VALUE) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Whether Windows would start *this* installation's tracker at sign-in.
///
/// A value naming a different path counts as not registered rather than as
/// registered. That is what an install into another directory leaves behind,
/// and Windows would launch nothing from it, so rewriting is the only repair.
pub(crate) fn startup_is_registered() -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Opened read-only, and absence is an answer rather than a failure: the
    // Run key itself does not exist on a profile that has never held one.
    let run = match hkcu.open_subkey(STARTUP_RUN_KEY) {
        Ok(run) => run,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let registered: String = match run.get_value(STARTUP_RUN_VALUE) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    Ok(registered == startup_command()?)
}

/// The https handler's ProgId from the per-user UserChoice key.
pub(crate) fn default_browser_prog_id() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(
        "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    )
    .ok()?
    .get_value::<String, _>("ProgId")
    .ok()
}

/// Open Explorer on the folder holding `path`, with the file selected.
pub(crate) fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new("explorer.exe");
    // Explorer parses /select itself and needs the quotes around the path
    // only, so the argument is written raw rather than quoted whole.
    command.raw_arg(format!("/select,\"{}\"", path.display()));
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

const fn colorref(red: u8, green: u8, blue: u8) -> u32 {
    red as u32 | ((green as u32) << 8) | ((blue as u32) << 16)
}

pub(crate) fn style_window_frame<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
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

/// Say why Time is not opening, on the one path where nothing else can.
///
/// A failure out of `setup()` ends the launch before there is a window for the
/// frontend to draw an error in, and the release binary is built
/// `windows_subsystem = "windows"`, so the panic that follows has no console to
/// print to either. What the reader gets is a shortcut that does nothing —
/// indistinguishable from a broken install, a bad shortcut, or a machine that
/// needs restarting, and impossible to report usefully. A launch failure that
/// cannot name itself gets attributed to whatever the reader was already
/// suspicious of, which is how a real one goes unfixed.
///
/// Win32 directly rather than the dialog plugin: `blocking_show` must not be
/// called from the main thread, which is where `setup` runs, and the
/// non-blocking form would be torn down with the process before it painted.
/// `MessageBoxW` owns its own message loop and needs no application.
pub(crate) fn report_fatal_launch_failure(error: &str) {
    use ::windows::core::HSTRING;
    use ::windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let text = HSTRING::from(format!(
        "Time could not open its database and has to close.\n\n{error}\n\n\
         Your recorded history has not been changed."
    ));
    let caption = HSTRING::from("Time could not start");
    // SAFETY: both strings outlive the call, and a null owner window is what
    // this needs — there is no application window at this point.
    unsafe {
        MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::process::{Child, Command};

    use super::*;

    /// A Run key of the test's own under HKCU, removed when the test ends,
    /// so nothing here can touch the registration Windows actually reads.
    struct ScratchRunKey {
        parent: String,
        run: RegKey,
    }

    impl ScratchRunKey {
        fn new() -> Self {
            let parent = format!(r"Software\Time-tests\{}", uuid::Uuid::new_v4());
            let (run, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(format!(r"{parent}\Run"))
                .expect("create scratch Run key");
            Self { parent, run }
        }

        fn value(&self) -> Option<String> {
            self.run.get_value(STARTUP_RUN_VALUE).ok()
        }
    }

    impl Drop for ScratchRunKey {
        fn drop(&mut self) {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let _ = hkcu.delete_subkey_all(&self.parent);
            // Fails while another test's key is still beneath it, which is
            // what makes it safe under parallel tests.
            let _ = hkcu.delete_subkey(r"Software\Time-tests");
        }
    }

    const OWN: &str = r#""C:\Repo\target\debug\time-tracker.exe""#;
    const INSTALLED: &str = r#""C:\Users\someone\AppData\Local\Time\time-tracker.exe""#;

    #[test]
    fn disabling_removes_this_builds_own_registration() {
        let key = ScratchRunKey::new();
        key.run.set_value(STARTUP_RUN_VALUE, &OWN).unwrap();

        remove_startup_value(&key.run, OWN).unwrap();

        assert_eq!(key.value(), None);
    }

    #[test]
    fn disabling_leaves_another_installations_registration() {
        let key = ScratchRunKey::new();
        key.run.set_value(STARTUP_RUN_VALUE, &INSTALLED).unwrap();

        remove_startup_value(&key.run, OWN).unwrap();

        assert_eq!(key.value().as_deref(), Some(INSTALLED));
    }

    #[test]
    fn disabling_matches_the_registration_without_regard_to_case() {
        let key = ScratchRunKey::new();
        key.run
            .set_value(STARTUP_RUN_VALUE, &OWN.to_uppercase())
            .unwrap();

        remove_startup_value(&key.run, OWN).unwrap();

        assert_eq!(key.value(), None);
    }

    #[test]
    fn disabling_with_nothing_registered_succeeds() {
        let key = ScratchRunKey::new();

        remove_startup_value(&key.run, OWN).unwrap();

        assert_eq!(key.value(), None);
    }

    /// A long-running stand-in for the tracker: `ping.exe` copied into its own
    /// directory under the tracker's file name, so two "trackers" differ only
    /// by path, the way an installed tracker and a dev build's do.
    struct StandIn {
        dir: PathBuf,
        path: PathBuf,
        child: Child,
    }

    impl StandIn {
        fn spawn() -> Self {
            let dir = std::env::temp_dir()
                .join("time-tests")
                .join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join(TRACKER_EXECUTABLE);
            let windir = std::env::var_os("SystemRoot").expect("SystemRoot");
            std::fs::copy(PathBuf::from(windir).join(r"System32\PING.EXE"), &path).unwrap();
            let mut command = Command::new(&path);
            command.args(["-n", "60", "127.0.0.1"]);
            hide_native_console(&mut command);
            let child = command.spawn().unwrap();
            Self { dir, path, child }
        }

        fn is_alive(&mut self) -> bool {
            self.child.try_wait().unwrap().is_none()
        }

        /// taskkill returns once termination is requested, not once the
        /// process has gone.
        fn wait_for_exit(&mut self) -> bool {
            for _ in 0..50 {
                if !self.is_alive() {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            false
        }
    }

    impl Drop for StandIn {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn finds_only_the_tracker_at_its_own_path() {
        let own = StandIn::spawn();
        let other = StandIn::spawn();

        assert_eq!(tracker_pids_at(&own.path).unwrap(), vec![own.child.id()]);
        assert_eq!(
            tracker_pids_at(&other.path).unwrap(),
            vec![other.child.id()]
        );
    }

    #[test]
    fn stopping_ends_this_builds_tracker_and_spares_another() {
        let mut own = StandIn::spawn();
        let mut other = StandIn::spawn();

        stop_trackers_at(&own.path).unwrap();

        assert!(own.wait_for_exit(), "own tracker still running");
        assert!(
            other.is_alive(),
            "another installation's tracker was stopped"
        );
        assert!(tracker_pids_at(&own.path).unwrap().is_empty());
    }

    #[test]
    fn stopping_with_no_tracker_running_succeeds() {
        let missing = std::env::temp_dir()
            .join("time-tests")
            .join(uuid::Uuid::new_v4().to_string())
            .join(TRACKER_EXECUTABLE);

        stop_trackers_at(&missing).unwrap();
        assert!(tracker_pids_at(&missing).unwrap().is_empty());
    }
}
