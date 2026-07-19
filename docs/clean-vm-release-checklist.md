# Clean-VM release checklist

Run this checklist on both Windows 10 and Windows 11 before a beta build ships.
The VM must not have Python, the repository, or a previous Time development
environment. Use a snapshot so each launch-order test can start genuinely clean.

The release artifact is:

`dashboard/src-tauri/target/release/bundle/nsis/Time_0.1.0_x64-setup.exe`

## 1. Fresh install and tracker-first launch

1. Confirm `python`, `pythonw`, and `py` are unavailable in a new terminal.
2. Run the NSIS installer. For an unsigned beta build, record the exact
   SmartScreen flow required to continue.
3. Leave "Launch Time" selected on the final page.
4. Within 30 seconds, confirm the Time tray icon is present and Settings reports
   the tracker as running.
5. In Task Manager, confirm `time-tracker.exe` is running and no Python process
   was installed or launched.
6. Open Registry Editor and verify this current-user value exists:
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Time Tracker`.
   Its quoted value must point to the installed `time-tracker.exe`.
7. Use several apps for at least one heartbeat interval. Confirm Overview gains
   positive-duration activity and Settings shows tracker version `0.1.0`.
8. Open the tray menu and verify its icon, recording/paused status, Pause,
   Resume, Open dashboard, and Quit tracker actions.
9. Pause for 15 minutes, use another app for at least one heartbeat, and confirm
   no new active session time is recorded. Resume and confirm tracking returns.

## 2. Dashboard-first launch order

1. Restore the clean VM snapshot.
2. Start the installer and, as soon as installation completes, open Time from
   the Start menu while the tracker is still initializing.
3. Confirm the dashboard shows its intentional waiting/first-run state and never
   exposes a raw SQLite or missing-table error.
4. Confirm the state resolves without relaunching once the tracker creates the
   database.

## 3. Reboot and autostart

1. Reboot without manually quitting the tracker first.
2. Sign back into the same Windows account.
3. Confirm one `time-tracker.exe` process and one tray icon appear without
   opening the dashboard.
4. Use an app for at least one heartbeat, then open Time and confirm the new
   activity was recorded without overlaps or negative durations.

## 4. Upgrade in place

1. Record the current session count, one changed setting, one custom category,
   and one rule.
2. Install the next build over the existing installation.
3. Confirm the installer stops the old tracker, replaces the app and one-dir
   runtime, and starts exactly one tracker afterward.
4. Confirm the session count, changed setting, category, and rule survive.
5. Confirm the HKCU Run value points to the current install path and tray Open
   dashboard launches the upgraded dashboard.

## 5. Uninstall and data retention

1. Note the exact database path shown in Settings and close the dashboard.
2. Uninstall Time from Windows Installed apps.
3. Confirm `time-tracker.exe` stops and the `Time Tracker` HKCU Run value is gone.
4. Confirm Time.exe, time-tracker.exe, `_internal`, shortcuts, and the
   uninstaller are removed.
5. Confirm `%LOCALAPPDATA%\Time\time_log.db` still exists. Also retain any
   `time_log.db-wal`, `time_log.db-shm`, backups, and Logs directory present;
   uninstall must not offer or perform data deletion.
6. Reboot once more and confirm the tracker does not return.

## 6. Windows-specific checks

- On Windows 10, verify the WebView2 bootstrap succeeds on a machine without a
  preinstalled runtime.
- On both OS versions, repeat once as a standard non-administrator user.
- Record installer hash, installer size, OS build, result, and any antivirus or
  SmartScreen warning in the release notes.
