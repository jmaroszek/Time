//! Restoring a backup across a restart: staging, the swap, rollback, and the notice.

use super::*;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestore {
    pub source_name: String,
    pub safety_backup_path: String,
    pub schema_version: i64,
    pub recording_consent: bool,
    pub launch_at_login: bool,
}

pub struct RestoreSwap {
    pub pending: PendingRestore,
    pub(super) rollback_path: PathBuf,
    pub(super) marker_path: PathBuf,
    pub(super) database_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreNotice {
    pub ok: bool,
    pub message: String,
}

impl RestoreSwap {
    pub fn commit(self) -> Result<(), String> {
        TimeDatabase::remove_if_exists(&self.marker_path)?;
        TimeDatabase::remove_if_exists(&self.rollback_path)
    }

    pub fn rollback(self) -> Result<(), String> {
        TimeDatabase::remove_database_sidecars(&self.database_path)?;
        let failed_path = TimeDatabase::failed_restore_path(&self.database_path)?;
        TimeDatabase::remove_if_exists(&failed_path)?;
        TimeDatabase::rename_with_retry(&self.database_path, &failed_path)?;
        if let Err(error) =
            TimeDatabase::rename_with_retry(&self.rollback_path, &self.database_path)
        {
            let _ = TimeDatabase::rename_with_retry(&failed_path, &self.database_path);
            return Err(error);
        }
        TimeDatabase::remove_if_exists(&self.marker_path)?;
        TimeDatabase::remove_if_exists(&failed_path)?;
        let pending_path = TimeDatabase::pending_database_path(&self.database_path)?;
        TimeDatabase::remove_if_exists(&pending_path)?;
        TimeDatabase::remove_database_sidecars(&pending_path)
    }
}

impl TimeDatabase {
    /// A file beside the database. The restore set all lives here, and the
    /// failure mode this guards — a database path with no parent — is the same
    /// for every one of them.
    fn sibling(database_path: &Path, name: &str) -> Result<PathBuf, String> {
        Ok(database_path
            .parent()
            .ok_or("database path has no parent")?
            .join(name))
    }

    pub(super) fn pending_database_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_pending.db")
    }

    pub(super) fn pending_marker_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_pending.json")
    }

    fn restore_notice_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_notice.json")
    }

    pub(super) fn rollback_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_previous.db")
    }

    /// Where a failed restore parks the database it could not replace. Named
    /// alongside the rest of the restore set rather than inlined at its one
    /// call site, so the whole set reads as a list.
    pub(super) fn failed_restore_path(database_path: &Path) -> Result<PathBuf, String> {
        Self::sibling(database_path, "restore_failed.db")
    }

    pub async fn prepare_restore(&self, source: PathBuf) -> Result<PendingRestore, String> {
        let source = fs::canonicalize(&source).map_err(|error| error.to_string())?;
        let live = fs::canonicalize(&self.path).map_err(|error| error.to_string())?;
        if source == live {
            return Err("Choose a backup, not the live Time database".into());
        }
        let pending_path = Self::pending_database_path(&self.path)?;
        let marker_path = Self::pending_marker_path(&self.path)?;
        // Must end in `.db`: SQLite names a log after the whole filename, and
        // the sidecar helpers derive it by replacing the last extension. A
        // `.tmp` staging name made those two disagree, so the copied log was
        // never replayed and its real one was still open at the rename.
        let temporary_path = pending_path.with_file_name("restore_staging.db");

        // Stage before validating. Reading the source and then copying it left a
        // window where the file could change in between; validating the staged
        // copy closes it, and the copy is what actually gets restored.
        Self::stage_consolidated_copy(&source, &temporary_path).await?;
        let (schema_version, recording_consent, launch_at_login) =
            match Self::read_restore_settings(&temporary_path, true).await {
                Ok(settings) => settings,
                Err(error) => {
                    Self::remove_if_exists(&temporary_path)?;
                    return Err(error);
                }
            };
        if schema_version > SCHEMA_VERSION {
            Self::remove_if_exists(&temporary_path)?;
            return Err(format!(
                "This backup uses schema {schema_version}; this Time version supports {SCHEMA_VERSION}"
            ));
        }
        let safety_backup_path = self.backup_named("backup_pre_restore").await?;
        Self::remove_if_exists(&pending_path)?;
        Self::remove_database_sidecars(&pending_path)?;
        // Both pools that read the staged copy have just closed, which is the
        // case `rename_with_retry` exists for.
        Self::rename_with_retry(&temporary_path, &pending_path)?;
        let _ = Self::remove_database_sidecars(&temporary_path);
        let pending = PendingRestore {
            source_name: source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("selected backup")
                .to_owned(),
            safety_backup_path,
            schema_version,
            recording_consent,
            launch_at_login,
        };
        if let Err(error) = Self::write_json_atomic(&marker_path, &pending) {
            let _ = Self::remove_if_exists(&pending_path);
            return Err(error);
        }
        Ok(pending)
    }

    pub async fn refresh_pending_safety_backup(
        &self,
        pending: &mut PendingRestore,
    ) -> Result<(), String> {
        let previous = PathBuf::from(&pending.safety_backup_path);
        let current = self.backup_named("backup_pre_restore").await?;
        pending.safety_backup_path = current;
        Self::write_json_atomic(&Self::pending_marker_path(&self.path)?, pending)?;
        // The first snapshot protected the validation/staging phase. Once the
        // stopped-tracker snapshot is durably named in the marker, only that
        // later copy is needed.
        let _ = Self::remove_if_exists(&previous);
        Ok(())
    }

    pub fn cancel_pending_restore(&self) -> Result<(), String> {
        let pending_path = Self::pending_database_path(&self.path)?;
        Self::remove_if_exists(&pending_path)?;
        Self::remove_database_sidecars(&pending_path)?;
        Self::remove_if_exists(&Self::pending_marker_path(&self.path)?)
    }

    /// Whether a failed startup restore may have left the original outside the
    /// live path. A rollback copy alongside a still-staged replacement means the
    /// swap never began (it renames the staged copy away), so that copy is a
    /// leftover from an earlier restore and canceling this one is safe.
    pub fn restore_needs_recovery(database_path: &Path) -> bool {
        let exists = |path: Result<PathBuf, String>| path.is_ok_and(|path| path.exists());
        !database_path.exists()
            || (exists(Self::rollback_path(database_path))
                && !exists(Self::pending_database_path(database_path)))
    }

    pub async fn begin_pending_restore(
        database_path: &Path,
    ) -> Result<Option<RestoreSwap>, String> {
        let marker_path = Self::pending_marker_path(database_path)?;
        let pending_path = Self::pending_database_path(database_path)?;
        let rollback_path = Self::rollback_path(database_path)?;
        let failed_path = Self::failed_restore_path(database_path)?;
        // Rollback parks the rejected database before putting the original
        // back. That file also identifies an interrupted rollback, including
        // an exit after the original was restored but before cleanup finished.
        if failed_path.exists() && !pending_path.exists() {
            if rollback_path.exists() && !database_path.exists() {
                Self::remove_database_sidecars(database_path)?;
                Self::rename_with_retry(&rollback_path, database_path)?;
            }
            if database_path.exists() && !rollback_path.exists() {
                Self::remove_if_exists(&marker_path)?;
                let _ = Self::remove_if_exists(&failed_path);
                let _ = Self::write_restore_notice(database_path, RestoreNotice {
                    ok: false,
                    message: "An interrupted restore was rolled back; the previous database was recovered.".into(),
                });
                return Ok(None);
            }
        }
        if !marker_path.exists() {
            // commit() removes the marker before deleting its rollback copy.
            // An exit between those operations must not block the next restore.
            if database_path.exists() && !pending_path.exists() && rollback_path.exists() {
                let _ = Self::remove_if_exists(&rollback_path);
            }
            return Ok(None);
        }
        let pending: PendingRestore =
            serde_json::from_slice(&fs::read(&marker_path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Could not read pending restore: {error}"))?;

        // A process exit between the two renames leaves the old database in the
        // rollback slot. Put it back before retrying the staged swap.
        if rollback_path.exists() && !database_path.exists() && pending_path.exists() {
            Self::rename_with_retry(&rollback_path, database_path)?;
        }
        if rollback_path.exists() && database_path.exists() && !pending_path.exists() {
            let restored = Self::read_restore_settings(database_path, true).await;
            let mut swap = RestoreSwap {
                pending,
                rollback_path,
                marker_path,
                database_path: database_path.to_path_buf(),
            };
            // The tracker may have committed migration before the host exited.
            // That is a valid continuation of this swap, not a different backup.
            match restored {
                Ok((version, _, _))
                    if version == swap.pending.schema_version
                        || (swap.pending.schema_version < SCHEMA_VERSION
                            && version == SCHEMA_VERSION) =>
                {
                    swap.pending.schema_version = version;
                    return Ok(Some(swap));
                }
                result => {
                    let error = result.err().unwrap_or_else(|| {
                        "Restored database does not match its pending marker".into()
                    });
                    // Validation failed after the swap, so leaving this file in
                    // place and discarding the marker would strand the original.
                    swap.rollback()?;
                    let _ = Self::write_restore_notice(database_path, RestoreNotice {
                        ok: false,
                        message: format!("Interrupted restore failed and the previous database was recovered: {error}"),
                    });
                    return Ok(None);
                }
            }
        }
        if rollback_path.exists() && database_path.exists() && pending_path.exists() {
            // The swap renames the staged copy away, so it has not started. This
            // rollback copy is left from an earlier, committed restore whose
            // cleanup failed; the swap needs its name.
            Self::remove_if_exists(&rollback_path)?;
        }
        if rollback_path.exists() {
            return Err("A previous database restore did not finish cleanly".into());
        }
        let staged = Self::read_restore_settings(&pending_path, true).await?;
        if staged.0 != pending.schema_version {
            return Err("Staged database does not match its pending marker".into());
        }
        // Best effort, and deliberately so: a database too damaged to open is
        // one of the reasons to restore in the first place, and refusing to
        // proceed would strand the user with the file they are replacing. The
        // safety copy taken before the tracker stopped still holds this data.
        let _ = Self::checkpoint_wal(database_path).await;
        Self::remove_database_sidecars(database_path)?;
        Self::rename_with_retry(database_path, &rollback_path)?;
        if let Err(error) = Self::rename_with_retry(&pending_path, database_path) {
            // Putting the original back is the only thing between a failed swap
            // and an empty database opened over the user's history. Discarding
            // that failure left no database in place, and the caller could not
            // tell the difference, so say it plainly instead.
            if let Err(rollback) = Self::rename_with_retry(&rollback_path, database_path) {
                return Err(format!(
                    "The restore could not be applied ({error}) and the previous database could \
                     not be put back ({rollback}). It is saved as {}",
                    rollback_path.display()
                ));
            }
            return Err(error);
        }
        // SQLite only cleans up a `-wal`/`-shm` pair for a database still where
        // it left it, so every rename here orphans one under the old name.
        // Never worth failing a completed swap over.
        let _ = Self::remove_database_sidecars(&pending_path);
        Ok(Some(RestoreSwap {
            pending,
            rollback_path,
            marker_path,
            database_path: database_path.to_path_buf(),
        }))
    }

    pub fn discard_pending_restore(database_path: &Path, message: String) -> Result<(), String> {
        let pending_path = Self::pending_database_path(database_path)?;
        Self::remove_if_exists(&pending_path)?;
        Self::remove_database_sidecars(&pending_path)?;
        Self::remove_if_exists(&Self::pending_marker_path(database_path)?)?;
        Self::write_restore_notice(database_path, RestoreNotice { ok: false, message })
    }

    pub fn write_restore_notice(database_path: &Path, notice: RestoreNotice) -> Result<(), String> {
        Self::write_json_atomic(&Self::restore_notice_path(database_path)?, &notice)
    }

    pub fn take_restore_notice(database_path: &Path) -> Result<Option<RestoreNotice>, String> {
        let path = Self::restore_notice_path(database_path)?;
        if !path.exists() {
            return Ok(None);
        }
        let notice = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        Self::remove_if_exists(&path)?;
        Ok(Some(notice))
    }
}
