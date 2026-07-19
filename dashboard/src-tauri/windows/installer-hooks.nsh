!define TIME_TRACKER_EXE "time-tracker.exe"
!define TIME_TRACKER_RUN_VALUE "Time Tracker"

; Stop the old sidecar before an upgrade replaces its one-dir files.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "Time tracker"
!macroend

; Autostart for the current user and start tracking immediately on first install.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "${TIME_TRACKER_RUN_VALUE}" "$\"$INSTDIR\${TIME_TRACKER_EXE}$\""
  Exec '"$INSTDIR\${TIME_TRACKER_EXE}"'
!macroend

; Leave %LOCALAPPDATA%\Time intact: it contains the user's SQLite history.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "Time tracker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
    "${TIME_TRACKER_RUN_VALUE}"
!macroend
