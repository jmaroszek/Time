# Time

A personal time tracker for Windows I built to answer one question:
**how do I spend time on my computer?**

A lightweight Python tracker runs in the background after explicit consent and
records foreground-app timing to SQLite. A Tauri 2 + React
dashboard turns that into answers: how much I worked, on what, and
how that is changing over time.

![Insights tab](docs/images/overview.png)

> All screenshots use a synthetic demo dataset
> ([scripts/make_demo_db.py](scripts/make_demo_db.py)) — plausible fake weeks,
> nobody's real browsing history.

## Features

- **A useful record of your day.** Every stretch of focus on an app becomes one
  session — what it was, when it started, when it ended —
  so any day can be replayed block by block. App switches register within a
  second.
- **Honest about breaks.** Step away and the time doesn't count: after the
  idle threshold with no input you're marked away, and the period is back-dated
  to your last keystroke so idle minutes never pad the stats. Supported
  foreground media stays active while Windows reports it as playing; pausing
  begins away time at that moment. Locking the screen counts as away
  immediately, and sleep records no timeline block. Awake away rows retain the
  foreground app/site identity for inspection, but replace the window title
  with the away reason; locked rows retain no foreground identity.
- **Optional site-level browser time.** Domains can be derived from browser
  titles produced by a third-party URL-title extension. URL paths, queries,
  fragments, and credentials are stripped before storage. No extension is
  required for app-level browser tracking. The same domain signal lets Time
  distinguish foreground browser playback from media in a background tab.
- **Your own definition of productive.** Apps and websites are grouped into
  custom categories and simple rules, all edited in the dashboard. New installs
  contain no personal categories or classification rules. Changes apply to all history, and the tracker
  picks them up within seconds — no config files, no restarts.
- **Friendly app names.** Cryptic executable names can be
  renamed in Insights' Top Apps or the Activity Library, and the friendly name
  shows everywhere with the recorded executable still available in Activity.
- **Tells you what actually changed.** Week-over-week shifts in app usage are
  highlighted only when they're statistically real (a Welch's t-test on daily
  usage), and color depends on direction: more time in a productive app is
  green, more in a distracting one is red.
- **Never loses meaningful data.** The tracker runs all day and survives
  crashes, restarts, and double launches — at worst the last 15 seconds are
  lost, because the open session is flushed to disk on that heartbeat. The
  tracker and dashboard share one SQLite file (WAL mode) safely.

## The dashboard

| Tab | What it shows |
| --- | --- |
| **[Insights](docs/overview.md)** | KPI cards (total, productive %, longest focus chain, goal pace); an adaptive main view that shifts with the range — a per-day timeline, a weekday×hour rhythm heatmap, or a day/month calendar (shadeable by total, productive, unproductive, or neutral time); top apps with category-aware deltas; and activity hours stacked by state or category. Ranges run from a single day to all time. |
| **[Activity](docs/apps.md)** | Search and correct the apps, websites, windows, and sessions in the shared range; classify them with categories and rules; or delete exact recorded activity. |
| **[Settings](docs/settings.md)** | Goals, AFK threshold, heartbeat, week start, browser processes, history retention, live tracker status, and one-click backup. |

## Architecture

```
tracker/      Python, always on: Win32 foreground/idle probe -> session rows
dashboard/    Tauri 2 + React + ECharts, launched on demand: reads sessions,
              owns categories/rules/settings
```

The two halves share a SQLite database (WAL) at
`%LOCALAPPDATA%\Time\time_log.db`. Both resolve that fixed per-user path
independently. Settings written by the dashboard are re-read by the tracker
every heartbeat. Both executables verify `schema_version` and refuse unsafe
writes; new schemas are bootstrapped directly at the current public contract.

## Running it

```powershell
pythonw tracker/tracker.py          # tracker (headless)
cd dashboard; npm run tauri dev     # dashboard (dev)
cd dashboard; npm run tauri build   # one NSIS installer with packaged tracker

py -m coverage run -m pytest tracker/tests scripts/tests
py -m coverage report                       # Python branch-coverage ratchet
cd dashboard; npm run test:coverage         # dashboard V8 branch coverage
cd dashboard; npm run test:device           # deterministic renderer suite
py scripts/check_db_anomalies.py <backup-or-beta-db>  # read-only health check
```

Before a release, run the native window-state suite. It drives the built
application through WebDriver, so it needs the sidecar, a debug build, and a
real Windows desktop session — CI cannot run it:

```powershell
py scripts\build_tracker.py           # only if src-tauri\binaries\ is empty
cd dashboard
npm run build:native-device           # src-tauri\target\debug\Time.exe
npm run test:native:doctor            # refuses live/production state
npm run test:native
```

The release build runs PyInstaller automatically, carries its one-dir tracker
runtime as a Tauri sidecar, and produces one current-user NSIS installer. The
installer bootstraps the local database but records nothing and creates no
startup entry until the user opts in. Uninstall removes the process/autostart
entry while keeping the user's database.
Complete the owner-run clean-VM release checklist on Windows 10 and Windows 11
before shipping an artifact. Automated source checks do not replace that
evidence. Invited testers should receive the
[beta invite note](docs/beta-invite.md) with the build's SHA-256 hash filled in.

During a beta soak, run the anomaly checker weekly against an explicit database
path (or, more conservatively, a fresh backup). It opens SQLite read-only, runs
`integrity_check`, and reports duration, AFK-identity, overlap, rule, foreign-key,
and schema-contract violations. Exit code 0 means every check passed; `--json`
produces machine-readable output.

For source development, the tracker can still run through
`pythonw.exe tracker\tracker.py`; the single-instance mutex makes duplicate
launches harmless.

Both halves default the database to `%LOCALAPPDATA%\Time\time_log.db`, creating
it on first run. Debug dashboard builds accept `TIME_DB_PATH`; the tracker uses
`TIME_DATA_DIR`. Release builds ignore database-path overrides:

```powershell
py scripts/make_demo_db.py     # writes data/demo.db, ~12 weeks of fake life
$env:TIME_DB_PATH = "$PWD/data/demo.db"; cd dashboard; npm run tauri dev
```

## Privacy and security

Tracking is disabled until an explicit first-run choice. Window titles are a
separate opt-in and are off by default; browser URLs are sanitized before a
session is written. Time has no account, network client, cloud sync, analytics,
or telemetry. The dashboard uses a restrictive content-security policy and a
fixed-path, least-authority database bridge. See [SECURITY.md](SECURITY.md) for
the threat model, at-rest limitations, vulnerability reporting, and the signed
release requirements.
