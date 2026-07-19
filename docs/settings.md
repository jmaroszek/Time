# Settings tab

Every knob lives in the database and is edited here. You do not need to edit config files, or even restart the app after making a change. 

![Settings tab](images/settings.png)

## Tracking & Goals

| Setting | What it controls |
| --- | --- |
| **Weekly productive goal** | The target the Overview goal-pace card measures against. |
| **Day starts/ends at** | The hour window drawn on the Timeline and Hour-of-Day plots. Activity outside the window still counts in all totals. |
| **AFK idle threshold** | How long without input counts as away. The AFK boundary is back-dated to the last real input, so the threshold doesn't leak into the stats. Note this means passively watching video without touching the mouse or keyboard counts as away. |
| **Focus chain max gap** | The longest break between productive sessions that still counts as one focus chain. |
| **Minimum app time** | Apps below this in the range are hidden from app lists; the list header notes what's hidden. |
| **Heartbeat interval** | How often the open session's end time is flushed to disk; this is the upper bound on data lost in a crash. |
| **Week starts on** | Affects weekly presets, trends bucketing, and goal pacing. |
| **Browser processes** | Which executables get domain parsing and domain/title rule treatment. |

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
Privacy section deletes recorded history matching a text (app, window title,
or site) or older than a cutoff - both show the affected count and ask for
confirmation, and neither touches categories, rules, or settings.
