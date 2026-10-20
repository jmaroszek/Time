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
    let mut command = Command::new("taskkill");
    command.args(["/IM", TRACKER_EXECUTABLE, "/T", "/F"]);
    hide_native_console(&mut command);
    let status = command.status().map_err(|e| e.to_string())?;
    // taskkill returns 128 when no matching process exists; both states are
    // safe for a privacy erase because no tracker can write afterward.
    if status.success() || status.code() == Some(128) {
        return Ok(());
    }
    Err(format!("Could not stop tracker (taskkill exit {status})"))
}

pub(crate) fn tracker_is_running() -> Result<bool, String> {
    let filter = format!("IMAGENAME eq {TRACKER_EXECUTABLE}");
    let mut command = Command::new("tasklist");
    command.args(["/FI", filter.as_str(), "/NH"]);
    hide_native_console(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not query tracker status ({})",
            output.status
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    Ok(text.contains(TRACKER_EXECUTABLE))
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
    Ok(format!("\"{}\"", path.display()))
}

pub(crate) fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu
        .create_subkey(STARTUP_RUN_KEY)
        .map_err(|e| e.to_string())?;
    if enabled {
        run.set_value(STARTUP_RUN_VALUE, &startup_command()?)
            .map_err(|e| e.to_string())?;
    } else {
        match run.delete_value(STARTUP_RUN_VALUE) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
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
