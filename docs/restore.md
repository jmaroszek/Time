# Backing up and restoring the database

All of your data lives in one SQLite file:

```
%LOCALAPPDATA%\Time\Data\database.db
```

(The exact path is shown — with a copy button — in **Settings → Database**.)

## Making a backup

Click **Back up now** in Settings. This writes a complete, self-contained
snapshot named `backup_manual_<timestamp>.db` into:

```
%LOCALAPPDATA%\Time\Data\Backups\
```

The full path is shown when it finishes. It is safe to do this while the tracker
is running. Schema-update and pre-restore safety snapshots use the same folder.

Backups land on the same disk as the live file — that protects against corruption
and mistakes, not against losing the drive. Occasionally copy a backup somewhere
else (cloud folder, external drive) if the history matters to you.

## Restoring a backup

1. Open **Settings → Data management → Restore backup**.
2. Choose a listed snapshot, or use **Choose another file**.
3. Review its date, size, schema, and the replacement warning.
4. Select **Restore and restart**.

Time checks the backup's SQLite integrity and schema before touching current
data. It then creates a `backup_pre_restore_<timestamp>.db` safety snapshot,
stops the tracker, stages the selected file, and restarts. The actual file swap
happens before the dashboard reopens, when no dashboard connection owns the
database. A rollback copy is kept until the restored database opens
successfully.

If the snapshot uses an older supported schema, the packaged tracker migrates it
before the dashboard connects. If validation, migration, or reopening fails,
Time puts the previous database back and reports the failure after restart.

## Notes

- The backup is an ordinary SQLite database — any SQLite browser can open it.
- Restoring replaces *everything*: sessions, categories, rules, and settings
  revert to the moment the backup was taken. Activity recorded after that
  backup is lost.
- Legacy `backup_*.db` files beside `database.db` remain discoverable; Time does
  not silently move them.
