# Time

A personal time tracker for Windows I built to answer one question:
**how do I spend time on my computer?**

A lightweight Python tracker runs in the background after explicit consent and
records foreground-app timing to SQLite. A Tauri 2 + React
dashboard turns that into answers: how much I worked, on what, and
how that is changing over time.

![Overview tab](docs/images/overview.png)

> All screenshots use a synthetic demo dataset
> ([scripts/make_demo_db.py](scripts/make_demo_db.py)) — plausible fake weeks,
> nobody's real browsing history.

## Features

- **A useful record of your day.** Every stretch of focus on an app becomes one
  session — what it was, when it started, when it ended —
  so any day can be replayed block by block. App switches register within a
  second.
- **Honest about breaks.** Step away and the time doesn't count: after 3
  minutes of no input you're marked away, and the away period is back-dated
  to your last keystroke so idle minutes never pad the stats. Locking the
  screen counts as away immediately.
- **Optional site-level browser time.** Domains can be derived from browser
  titles produced by a third-party URL-title extension. URL paths, queries,
  fragments, and credentials are stripped before storage. No extension is
  required for app-level browser tracking.
- **Your own definition of productive.** Apps and websites are grouped into
  custom categories and simple rules, all edited in the dashboard. New installs
  contain no personal categories or classification rules. Changes apply to all history, and the tracker
  picks them up within seconds — no config files, no restarts.
- **Friendly app names.** Cryptic executable names can be
  renamed in place — double-click any app in the Apps tab — and the friendly
  name shows everywhere, with the real process name still a hover away.
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
| **[Overview](docs/overview.md)** | KPI cards (total, productive %, longest focus chain, goal pace), a per-day timeline of color-coded focus blocks, top apps with category-aware deltas, and daily productive/non-productive hours. |
| **[Trends](docs/trends.md)** | Weekly hours stacked by category over 12 weeks, and a productive-time heatmap by hour of day × day of week. |
| **[Apps](docs/apps.md)** | Every app and domain in range with time, share, and category — plus full category and rule management. |
| **[Settings](docs/settings.md)** | Goals, AFK threshold, heartbeat, week start, browser processes — all editable in-app — plus live tracker status and one-click backup. |

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

py -m pytest tracker/tests scripts/tests   # python tests
cd dashboard; npx vitest run               # dashboard tests
py scripts/check_db_anomalies.py <backup-or-beta-db>  # read-only health check
```

The release build runs PyInstaller automatically, carries its one-dir tracker
runtime as a Tauri sidecar, and produces one current-user NSIS installer. The
installer bootstraps the local database but records nothing and creates no
startup entry until the user opts in. Uninstall removes the process/autostart
entry while keeping the user's database.
Follow the [clean-VM release checklist](docs/clean-vm-release-checklist.md)
before shipping an artifact. Invited testers should receive the
[beta invite note](docs/beta-invite.md) with the build's SHA-256 hash filled in.

During a beta soak, run the anomaly checker weekly against an explicit database
path (or, more conservatively, a fresh backup). It opens SQLite read-only, runs
`integrity_check`, and reports duration, overlap, AFK/domain, rule, foreign-key,
and schema-contract violations. Exit code 0 means every check passed; `--json`
produces machine-readable output.

For source development, the tracker can still run through
`pythonw.exe tracker\tracker.py`; the single-instance mutex makes duplicate
launches harmless.

Both halves default the database to `%LOCALAPPDATA%\Time\time_log.db`, creating
it on first run. Debug dashboard builds accept `TIME_DB_PATH`; the tracker uses
`TIME_DATA_DIR`. Release builds ignore database-path overrides:

```powershell
py scripts/make_demo_db.py     # writes Data/demo.db, ~12 weeks of fake life
$env:TIME_DB_PATH = "$PWD/Data/demo.db"; cd dashboard; npm run tauri dev
```

## Privacy and security

Tracking is disabled until an explicit first-run choice. Window titles are a
separate opt-in and are off by default; browser URLs are sanitized before a
session is written. Time has no account, network client, cloud sync, analytics,
or telemetry. The dashboard uses a restrictive content-security policy and a
fixed-path, least-authority database bridge. See [SECURITY.md](SECURITY.md) for
the threat model, at-rest limitations, vulnerability reporting, and the signed
release requirements.
