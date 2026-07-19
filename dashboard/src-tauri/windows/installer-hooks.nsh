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

; Leave %LOCALAPPDATA%\Time intact: it contains the user's SQLite history.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "Time tracker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "${TIME_TRACKER_RUN_VALUE}"
!macroend
