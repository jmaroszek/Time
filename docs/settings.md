# Settings tab

Every knob lives in the database and is edited here. You do not need to edit config files, or even restart the app after making a change. 

![Settings tab](images/settings.png)

## Tracking & Goals

| Setting | What it controls |
| --- | --- |
| **Weekly productive goal** | The target the Overview goal-pace card measures against. |
| **AFK idle threshold** | How long without input counts as away. The AFK boundary is back-dated to the last real input, so the threshold doesn't leak into the stats. |
| **Heartbeat interval** | How often the open session's end time is flushed to disk; this is the upper bound on data lost in a crash. |
| **Week starts on** | Affects weekly presets, trends bucketing, and goal pacing. |
| **Browser processes** | Which executables get domain parsing and domain/title rule treatment. |

Settings save on Enter or focus-out; the tracker re-reads them within one
heartbeat.

## Tracker & Database

Live health check: whether a tracker heartbeat has been seen recently, the
database path, and session counts. 

**Back up database now** runs SQLite's
`VACUUM INTO` for a consistent snapshot next to the live file — safe while
both the tracker and dashboard are running.
