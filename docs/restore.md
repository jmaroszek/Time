# Backing up and restoring the database

All of your data lives in one SQLite file:

```
%LOCALAPPDATA%\Time\time_log.db
```

(The exact path is shown — with a copy button — in **Settings → Database**.)

## Making a backup

Click **Back up database now** in Settings. This writes a complete, self-contained
snapshot named `backup_manual_<timestamp>.db` into the same folder as the live
database, and shows you the full path when it finishes. It is safe to do this while
the tracker is running.

Backups land on the same disk as the live file — that protects against corruption
and mistakes, not against losing the drive. Occasionally copy a backup somewhere
else (cloud folder, external drive) if the history matters to you.

## Restoring a backup

1. **Stop the tracker.** End the `pythonw` process running `tracker.py`
   (Task Manager → find the Python process, or close it however you started it).
2. **Close the dashboard.**
3. In `%LOCALAPPDATA%\Time\`, rename the current `time_log.db` out of the way
   (e.g. `time_log.broken.db`) — don't delete it until the restore is confirmed.
4. Copy your chosen backup file into the folder and rename the copy to
   `time_log.db`.
5. **Delete the stale sidecar files** `time_log.db-wal` and `time_log.db-shm`
   if they exist. They belong to the old database; leaving them would corrupt
   the restored one.
6. Restart the tracker, then open the dashboard.
7. Verify: Settings shows "Tracker is live", and a historical day you remember
   looks right. New activity should start appearing within a minute.
8. Once satisfied, delete the renamed broken file.

## Notes

- The backup is an ordinary SQLite database — any SQLite browser can open it.
- Restoring replaces *everything*: sessions, categories, rules, and settings
  revert to the moment the backup was taken. Activity recorded after that
  backup is lost.
