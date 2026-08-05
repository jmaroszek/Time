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
- **Optional site-level browser time.** The first-party Time Website
  Integration extension adds the current origin and path to the browser title
  while excluding queries and fragments. Time derives only the normalized
  domain and immediately discards the raw origin/path; credentials are never
  exposed by the extension. No extension is required for app-level browser
  tracking. The same domain signal lets Time distinguish foreground browser
  playback from media in a background tab.
- **Your own definition of productive.** Apps and websites are grouped into
  custom categories and simple rules, all edited in the dashboard. New installs
  contain no personal categories or classification rules. Changes apply to all history, and the tracker
  picks them up within seconds — no config files, no restarts.
- **Friendly app names.** Cryptic executable names can be
  renamed in Insights' Top Apps or Activity's Apps & Websites, and the friendly name
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

## Installing it

Time is distributed as a signed installer for Windows from
[trackwithtime.com](https://trackwithtime.com). It bootstraps the local database
but records nothing and creates no startup entry until you opt in; uninstalling
removes the app and its autostart entry while keeping your database.

## Privacy and security

Tracking is disabled until an explicit first-run choice. Window titles are a
separate opt-in and are off by default; browser URLs are sanitized before a
session is written. Time has no account, network client, cloud sync, analytics,
or telemetry. The dashboard uses a restrictive content-security policy and a
fixed-path, least-authority database bridge. See [SECURITY.md](SECURITY.md) for
the threat model, at-rest limitations, vulnerability reporting, and the signed
release requirements.

## About this source code

This repository is public so anyone can read the code and see exactly what Time
does with their data. A time tracker asks for a lot of trust, and being able to
check the claims is worth more than any wording on a privacy page.

Readable is not the same as free. Time is commercial software: the source is
published for inspection, not licensed for use. The [license](LICENSE.md)
permits reading it, and compiling it to confirm that a release matches the
source, but the right to install and run Time comes with a copy supplied by its
author. Copies given directly to beta testers carry their own permission.

Please open an issue rather than a pull request — outside contributions cannot
be merged without a contributor agreement, because the project has to stay
licensable by its owner.
