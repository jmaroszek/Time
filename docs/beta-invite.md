# Time beta invite note

Time is a small Windows time tracker from Jonah. This beta is for invited
testers; it is not yet code-signed.

## Before installing

- Download the installer only from the link Jonah sent you.
- Compare its SHA-256 value with the hash in Jonah's message. In PowerShell:

  ```powershell
  Get-FileHash .\Time_0.1.0_x64-setup.exe -Algorithm SHA256
  ```

- Windows SmartScreen will probably show **Windows protected your PC** and
  **Unknown publisher** because the beta is unsigned. If the filename and hash
  match, choose **More info → Run anyway**. Do not disable SmartScreen globally.
- If the hash does not match—or the installer came from somewhere else—do not
  run it; tell Jonah.

## What the beta records

Time records the foreground application's process name, window title, start/end
times, and idle periods. The data stays in a local SQLite database under
`%LOCALAPPDATA%\Time`; Time has no account, cloud sync, analytics, or telemetry.
Window titles can contain sensitive text, so use the beta only on a computer
where that local history is appropriate.

Browser time works per application without any extension. Splitting it by site
is optional and uses the third-party **URL in title** browser extension. Time is
not affiliated with that extension; review its permissions before installing it.
Time itself reads only the resulting browser window title, not page contents.

## What to test

After installation, confirm the tray icon appears, use several applications for
at least a minute, then open Time and check that activity appears. Reboot once to
confirm tracking starts automatically. Report the Windows version, what you were
doing, what you expected, and a screenshot or exact error text for any problem.

Uninstalling removes the application and autostart entry but intentionally keeps
`%LOCALAPPDATA%\Time` so beta history is not destroyed. Delete that folder
manually only if you want to erase the retained data.
