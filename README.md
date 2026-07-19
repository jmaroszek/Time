# Time

A personal time tracker for Windows I built to answer one question:
**how do I spend time on my computer?**

A lightweight Python tracker runs in the background all day (~20 MB RAM) and
records every stretch of foreground-app focus to SQLite. A Tauri 2 + React
dashboard turns that into answers: how much I worked, on what, and
how that is changing over time.

![Overview tab](docs/images/overview.png)

> All screenshots use a synthetic demo dataset
> ([scripts/make_demo_db.py](scripts/make_demo_db.py)) — plausible fake weeks,
> nobody's real browsing history.

## Features

- **A complete record of your day.** Every stretch of focus on an app or
  window becomes one session — what it was, when it started, when it ended —
  so any day can be replayed block by block. App switches register within a
  second.
- **Honest about breaks.** Step away and the time doesn't count: after 3
  minutes of no input you're marked away, and the away period is back-dated
  to your last keystroke so idle minutes never pad the stats. Locking the
  screen counts as away immediately.
- **Sees inside the browser.** `youtube.com` and `github.com` show up as
  separate things instead of hiding in one big "Chrome" blob — domains are
  read from the window title via a "URL in title" extension.
- **Your own definition of productive.** Apps and websites are grouped into
  custom categories (Dev, Gaming, Media, ...) by simple rules, all edited in
  the dashboard. Changes apply to all history instantly, and the tracker
  picks them up within seconds — no config files, no restarts.
- **Friendly app names.** Cryptic executables like `r5apex_dx12.exe` can be
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
| **[Overview](docs/overview.md)** | KPI cards (total, productive %, longest focus chain, goal pace), a per-day timeline of color-coded focus blocks, top apps with significance-tested deltas, and daily productive/non-productive hours. |
| **[Trends](docs/trends.md)** | Weekly hours stacked by category over 12 weeks, and a productive-time heatmap by hour of day × day of week. |
| **[Apps](docs/apps.md)** | Every app and domain in range with time, share, and category — plus full category and rule management. |
| **[Settings](docs/settings.md)** | Goals, AFK threshold, heartbeat, week start, browser processes — all editable in-app — plus live tracker status and one-click backup. |

## Architecture

```
tracker/      Python, always on: Win32 foreground/idle probe -> session rows
dashboard/    Tauri 2 + React + ECharts, launched on demand: reads sessions,
              owns categories/rules/settings
```

The two halves never talk to each other directly — a shared SQLite database
(WAL) at `%LOCALAPPDATA%\Time\time_log.db` is the contract. Both halves resolve
that path independently, so it holds wherever the code lives. Settings written
by the dashboard are re-read by the tracker every heartbeat.

## Running it

```powershell
pythonw tracker/tracker.py          # tracker (headless)
cd dashboard; npm run tauri dev     # dashboard (dev)
cd dashboard; npm run tauri build   # one NSIS installer with packaged tracker

py -m pytest tracker/tests scripts/tests   # python tests
cd dashboard; npx vitest run               # dashboard tests
```

The release build runs PyInstaller automatically, carries its one-dir tracker
runtime as a Tauri sidecar, and produces one current-user NSIS installer. The
installer starts the tracker immediately, registers it for logon, and removes
the process/autostart entry on uninstall while keeping the user's database.
Follow the [clean-VM release checklist](docs/clean-vm-release-checklist.md)
before shipping an artifact.

For source development, the tracker can still run through
`pythonw.exe tracker\tracker.py`; the single-instance mutex makes duplicate
launches harmless.

Both halves default the database to `%LOCALAPPDATA%\Time\time_log.db`, creating
it on first run. Override the tracker with the `TIME_DATA_DIR` env var and the
dashboard with `VITE_DB_PATH` — handy for pointing at demo data:

```powershell
py scripts/make_demo_db.py     # writes Data/demo.db, ~12 weeks of fake life
$env:VITE_DB_PATH = "$PWD/Data/demo.db"; cd dashboard; npm run tauri dev
```
