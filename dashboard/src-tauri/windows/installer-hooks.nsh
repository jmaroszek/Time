!define TIME_TRACKER_EXE "time-tracker.exe"
!define TIME_TRACKER_RUN_VALUE "Time Tracker"

; Names for the two "... is running!" prompts an install can raise. Time runs as
; two processes and both have to be closed, so two prompts is correct -- but the
; template names the dashboard by PRODUCTNAME, which is just "Time", so the pair
; read as the same dialog shown twice rather than as one prompt per process.
; Naming them for their jobs is the whole point of these strings.
!define TIME_TRACKER_LABEL "Time tracker"
!define TIME_DASHBOARD_LABEL "Time dashboard"

; Close both processes before an upgrade replaces their files.
;
; Order matters, and is what lets the dashboard prompt be renamed at all. The
; template runs its own CheckIfAppIsRunning immediately *after* this hook, using
; PRODUCTNAME as the label. Closing the dashboard here means that later check
; finds nothing running and stays silent, so the reader sees this hook's wording
; instead of the template's. Killing it twice is not a risk: the macro prompts
; only when the process is actually found.
;
; The tracker check is load-bearing and was removed once, on the reasoning that
; the uninstaller an upgrade runs first had already stopped it. Without it an
; in-place upgrade fails part-way through extraction with "Error opening file for
; writing" on a _internal\PIL\*.pyd the tracker still has mapped -- because the
; template's check only ever closes the dashboard, and nothing else in the
; installer knows the sidecar exists. Do not remove it without reproducing an
; upgrade over a *running* install first.
!macro NSIS_HOOK_PREINSTALL
  !ifndef MAINBINARYNAME
    ; Guards a silent failure rather than a loud one: an empty name would make
    ; the check look for ".exe", find nothing, prompt nobody, and leave the
    ; dashboard holding its files open.
    !error "MAINBINARYNAME is undefined; the dashboard process check would match nothing."
  !endif
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "${TIME_TRACKER_LABEL}"
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${TIME_DASHBOARD_LABEL}"
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
  !ifndef MAINBINARYNAME
    !error "MAINBINARYNAME is undefined; the dashboard process check would match nothing."
  !endif
  ; Both processes, named, and for the same reason as PREINSTALL: the
  ; uninstaller's own check follows this hook and would otherwise label the
  ; dashboard "Time".
  !insertmacro CheckIfAppIsRunning "${TIME_TRACKER_EXE}" "${TIME_TRACKER_LABEL}"
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${TIME_DASHBOARD_LABEL}"
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
