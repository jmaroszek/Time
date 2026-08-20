!define TIME_TRACKER_EXE "time-tracker.exe"
!define TIME_TRACKER_RUN_VALUE "Time Tracker"

; Stop the old sidecar before an upgrade replaces its one-dir files.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "Time tracker"
!macroend

; Recording is never enabled by installation alone. The dashboard's first-run
; privacy screen obtains explicit consent before starting or registering the
; tracker. Preserve an existing startup choice during an in-place upgrade; on
; a fresh install there is no Run value to preserve.
!macro NSIS_HOOK_POSTINSTALL
  ; Bootstrap the local schema, then exit without recording. The tracker only
  ; remains running after the dashboard has recorded the user's choice.
  Exec '"$INSTDIR\${TIME_TRACKER_EXE}"'
!macroend

; Leave %LOCALAPPDATA%\Time\Data intact: it holds the user's SQLite history.
; The uninstaller's closing RMDir on $INSTDIR is not recursive, so a Data
; directory with a database in it survives by refusing to be removed.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "Time tracker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "${TIME_TRACKER_RUN_VALUE}"
!macroend

; Honour the uninstaller's "delete application data" checkbox.
;
; Tauri's own handling of that box removes $LOCALAPPDATA\${BUNDLEID} -- the
; WebView2 profile under the bundle identifier. Time's history does not live
; there; it lives in %LOCALAPPDATA%\Time, chosen to be a name a person can find.
; So the box was offering to delete the user's data and deleting something else,
; which is worse than not offering at all: the one reader who wanted a clean
; removal was told they had got one.
;
; Both guards matter. $DeleteAppDataCheckboxState is the reader's answer, and
; $UpdateMode is what keeps an in-place upgrade -- which runs this uninstaller
; with the box in whatever state it defaults to -- from deleting the history it
; is supposed to carry forward. Removing either one turns an upgrade into data
; loss, so they are copied from the template block this hook runs directly after.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; currentUser install mode, so this resolves to the uninstalling user's own
    ; profile rather than whichever one elevated.
    SetShellVarContext current
    RmDir /r "$LOCALAPPDATA\Time"
  ${EndIf}
!macroend
