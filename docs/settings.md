# Settings tab

Every knob lives in the database and is edited here. You do not need to edit config files, or even restart the app after making a change. 

![Settings tab](images/settings.png)

## Tracking & Goals

| Setting | What it controls |
| --- | --- |
| **Weekly productive goal** | The target the Insights goal-pace card measures against. |
| **Day starts/ends at** | The hour window drawn on the Timeline and Hour-of-Day plots. Activity outside the window still counts in all totals. |
| **AFK idle threshold** | How long without input counts as away. The AFK boundary is back-dated to the last real input, so the threshold doesn't leak into the stats. Note this means passively watching video without touching the mouse or keyboard counts as away. |
| **Focus chain max gap** | The longest break between productive sessions that still counts as one focus chain. |
| **Minimum app time** | Apps below this in the range are hidden from app lists; the list header notes what's hidden. |
| **Heartbeat interval** | How often the open session's end time is flushed to disk; this is the upper bound on data lost in a crash. |
| **Week starts on** | Affects weekly presets, weekly bucketing, and goal pacing. |
| **Browser processes** | Which executables get domain parsing and domain/title rule treatment. |
| **Record activity** | Explicit consent switch for all foreground-app recording. |
| **Store window titles** | Separate sensitive-data opt-in; off by default. Browser URLs are sanitized even when enabled. |
| **Start at Windows sign-in** | Per-user startup registration; available only after recording is enabled. |

Settings save on Enter or focus-out; the tracker re-reads them within one
heartbeat.

## Tracker & Database

Live health check: whether a tracker heartbeat has been seen recently (with a
distinct paused state when tracking is paused from the tray), the database
path, and both halves' versions. 

**Back up database now** runs SQLite's
`VACUUM INTO` for a consistent snapshot next to the live file - safe while
both the tracker and dashboard are running. The full path of the backup is
shown on success; restore steps live in [restore.md](restore.md).

## Privacy

Everything Time records stays on your machine; nothing is uploaded. The
Privacy controls can delete history matching a text, delete history older than
a cutoff, or erase all sessions. Deletion uses SQLite secure-delete, then
checkpoints the WAL and compacts the database so removed title text is not left
in free pages. Categories, rules, and settings are retained; separately created
backup files are never deleted implicitly.
