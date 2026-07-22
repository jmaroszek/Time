# Settings tab

Every knob lives in the database and is edited here. You do not need to edit config files, or even restart the app after making a change. 

![Settings tab](images/settings.png)

Settings is a single column, read top to bottom: tracker status, what may be
recorded, then the knobs, then the data itself. Adding a setting makes the
column longer and never rearranges it.

## Recording & startup

| Setting | What it controls |
| --- | --- |
| **Record activity** | Explicit consent switch for all foreground-app recording. |
| **Store window titles** | Separate sensitive-data opt-in; off by default. Browser URLs are sanitized even when enabled. |
| **Start at Windows sign-in** | Per-user startup registration; available only after recording is enabled. |

A summary line reports how many apps and websites are excluded from tracking
outright. The list itself is managed in the [Activity tab](apps.md), under the
**Excluded from tracking** filter, next to the other per-item curation.

## Goals, window, and behavior

| Setting | What it controls |
| --- | --- |
| **Weekly productive goal** | The target the Insights goal-pace card measures against. |
| **Day starts/ends at** | The hour window drawn on the Timeline and Hour-of-Day plots. Activity outside the window still counts in all totals. |
| **Week starts on** | Affects weekly presets, weekly bucketing, and goal pacing. |
| **AFK idle threshold** | How long without input counts as away. The AFK boundary is back-dated to the last real input, so the threshold doesn't leak into the stats. Note this means passively watching video without touching the mouse or keyboard counts as away. |
| **Focus chain max gap** | The longest break between productive sessions that still counts as one focus chain. |
| **Fold noisy items** | Which throwaway rows the Activity Library hides: nothing, one-offs, or one-offs plus installers, drivers, and local files. Totals and Insights are untouched, categorized items are never folded, and the Library header can reveal what was folded. |
| **One-off time limit** / **One-off session limit** | An item counts as a one-off only when it is under the time limit *and* at or under the session limit. |
| **Minimum app time** | A rate: apps averaging less than this per tracked day are hidden only from Insights' Top Apps. Because it scales with the days that recorded activity, the same apps clear the bar on Today and on Year. Activity always shows the complete catalog. |
| **Heartbeat interval** | How often the open session's end time is flushed to disk; this is the upper bound on data lost in a crash. |
| **Browser processes** | Which apps can be split into Websites and use Website or Window rules. The common browsers ship in the list, and entries are normalized on save — `Chrome` and a pasted install path both become `chrome.exe`. |

Settings save on Enter or focus-out; the tracker re-reads them within one
heartbeat.

## Tracker status

Live health check: whether a tracker heartbeat has been seen recently, with a
distinct paused state when tracking is paused from the tray.

## Data

One card covering the whole life of the database: where it lives, how to save
it, and how to shed it — in that order, ending in the destructive row.

**Back up database now** runs SQLite's
`VACUUM INTO` for a consistent snapshot next to the live file - safe while
both the tracker and dashboard are running. The full path of the backup is
shown on success; restore steps live in [restore.md](restore.md). Both halves'
versions are shown here too, for diagnosing a mismatched install.

Everything Time records stays on your machine; nothing is uploaded. The same
card can delete sessions older than an age cutoff or erase all recorded
history. Exact app, website, window-match, and selected-session correction
lives in the [Activity tab](apps.md), where the scope can be previewed before
deletion.

Deletion uses SQLite secure-delete, checkpoints the WAL, and compacts the
database so removed title text is not left in free pages. Categories, rules,
aliases, and settings are retained. Separately created backup files are never
deleted implicitly. Erase all disables and shuts down the tracker before using
typed confirmation; targeted Activity deletion never stops it and protects the
current live session.
