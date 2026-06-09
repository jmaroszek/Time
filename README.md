# Time

Personal time tracking for Windows: a lightweight always-on Python tracker that
records foreground app **sessions** to SQLite, and a Tauri 2 dashboard for
analytics.

## Architecture

```
tracker/      Python 1s-polling tracker -> sessions table (always running, ~20MB RAM)
dashboard/    Tauri 2 + React + ECharts dashboard (launched on demand)
Data/         time_log.db (SQLite, WAL) - shared by both
scripts/      one-time migration from the legacy sample-based time_log table
```

- The tracker writes a row per *session* (app/title span), not per poll.
  AFK is back-dated to the last input; the lock screen is AFK immediately;
  the open session's end time is flushed every heartbeat (crash loses <=15s).
- Classification (categories + rules) and all settings live in the DB and are
  edited from the dashboard (Apps and Settings tabs). The tracker re-reads
  settings every heartbeat — no restarts needed.
- Browser domains are parsed from window titles; install a "URL in title"
  extension in Chrome/Thorium to enable per-domain rules and analytics.

## Run

```powershell
# tracker (headless)
pythonw tracker/tracker.py

# dashboard (dev)
cd dashboard; npm run tauri dev

# dashboard (installed build)
cd dashboard; npm run tauri build
```

## Auto-start the tracker (Task Scheduler)

```powershell
$action = New-ScheduledTaskAction -Execute "pythonw.exe" -Argument "C:\Users\jonah\Documents\Code\Time\tracker\tracker.py"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "TimeTracker" -Action $action -Trigger $trigger -Settings $settings
```

The tracker holds a single-instance mutex, so a duplicate launch exits cleanly.

## Tests

```powershell
py -m pytest tracker/tests scripts/tests   # tracker state machine, db, migration
cd dashboard; npx vitest run               # date ranges, classifier, KPI math
```

## Migration & rollback

`py scripts/migrate_samples.py` collapses the legacy `time_log` samples into
sessions (re-runnable; backs up to `Data/backup_pre_migration.db` first and
verifies per-day totals). The legacy table and the old app on `main` are left
untouched until cutover is signed off.

Rollback: stop the new tracker, `git checkout main`, run the old
`time_tracker.py` / `time_gui.py`. If you want the new tables gone, restore
`Data/backup_pre_migration.db` over `Data/time_log.db`.

## Configuration

Bootstrap paths: [tracker/config.py](tracker/config.py) (DB/log location) and
`VITE_DB_PATH` in `dashboard/.env` (dashboard's DB path; defaults to the repo
layout). Everything else is in the Settings tab.
