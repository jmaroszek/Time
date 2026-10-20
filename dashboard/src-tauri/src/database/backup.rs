//! Named backups: writing, listing, and inspecting them.

use super::*;
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub modified_sec: i64,
    pub bytes: u64,
    pub schema_version: Option<i64>,
    pub compatible: bool,
    pub issue: Option<String>,
    pub legacy_location: bool,
}

impl TimeDatabase {
    pub fn backups_dir(&self) -> Result<PathBuf, String> {
        let parent = self.path.parent().ok_or("database path has no parent")?;
        let directory = parent.join("Backups");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        Ok(directory)
    }

    pub(super) async fn backup_named(&self, prefix: &str) -> Result<String, String> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis();
        let target = self.backups_dir()?.join(format!("{prefix}_{stamp}.db"));
        let escaped = target.to_string_lossy().replace("'", "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    }

    pub async fn backup_with_name(&self, name: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the backup a name".into());
        }
        if name.starts_with("backup_")
            || name.ends_with('.')
            || name.ends_with(' ')
            || name.chars().any(|character| {
                matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                ) || character.is_control()
            })
        {
            return Err(
                "Backup names cannot start with backup_, contain path characters, or end with a period or space".into(),
            );
        }

        let target = self.backups_dir()?.join(format!("{name}.db"));
        if target.exists() {
            return Err("A backup with that name already exists. Choose a different name".into());
        }
        let escaped = target.to_string_lossy().replace("'", "''");
        sqlx::query(&format!("VACUUM INTO '{escaped}'"))
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    }

    pub(super) async fn read_restore_settings(
        path: &Path,
        integrity: bool,
    ) -> Result<(i64, bool, bool), String> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .create_if_missing(false)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| format!("Could not open backup: {error}"))?;
        let result = async {
            let settings_exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            )
            .fetch_one(&pool)
            .await
            .map_err(|error| error.to_string())?;
            if settings_exists == 0 {
                return Err("This file is not a versioned Time database".to_owned());
            }
            let raw_version = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='schema_version'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "This backup has no schema version".to_owned())?;
            let schema_version = raw_version
                .parse::<i64>()
                .map_err(|_| "This backup has an invalid schema version".to_owned())?;
            if schema_version < 1 {
                return Err("This backup predates supported Time databases".to_owned());
            }
            if integrity {
                let checks: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
                    .fetch_all(&pool)
                    .await
                    .map_err(|error| error.to_string())?;
                if checks.as_slice() != ["ok"] {
                    return Err(format!(
                        "Backup integrity check failed: {}",
                        checks.join("; ")
                    ));
                }
                let foreign_key_errors: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                        .fetch_one(&pool)
                        .await
                        .map_err(|error| error.to_string())?;
                if foreign_key_errors > 0 {
                    return Err(format!(
                        "Backup has {foreign_key_errors} foreign-key integrity errors"
                    ));
                }
            }
            let recording_consent = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='recording_consent'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string())?
            .as_deref()
                == Some("1");
            let launch_at_login = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key='launch_at_login'",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string())?
            .as_deref()
                == Some("1");
            Ok((schema_version, recording_consent, launch_at_login))
        }
        .await;
        pool.close().await;
        result
    }

    fn backup_kind(name: &str) -> String {
        if name.starts_with("backup_schema") {
            "Before update".to_owned()
        } else if name.starts_with("backup_pre_restore_") {
            "Before restore".to_owned()
        } else {
            "Manual".to_owned()
        }
    }

    async fn inspect_backup_path(
        path: PathBuf,
        legacy_location: bool,
    ) -> Result<DatabaseBackup, String> {
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err("Backup path is not a file".into());
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("Backup filename is not valid Unicode")?
            .to_owned();
        let modified_sec = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let inspected = Self::read_restore_settings(&path, false).await;
        let (schema_version, compatible, issue) = match inspected {
            Ok((version, _, _)) if version > SCHEMA_VERSION => (
                Some(version),
                false,
                Some(format!(
                    "Created by a newer Time database (schema {version}; this version supports {SCHEMA_VERSION})"
                )),
            ),
            Ok((version, _, _)) => (Some(version), true, None),
            Err(error) => (None, false, Some(error)),
        };
        Ok(DatabaseBackup {
            path: path.to_string_lossy().into_owned(),
            name: name.clone(),
            kind: Self::backup_kind(&name),
            modified_sec,
            bytes: metadata.len(),
            schema_version,
            compatible,
            issue,
            legacy_location,
        })
    }

    pub async fn inspect_backup(&self, path: PathBuf) -> Result<DatabaseBackup, String> {
        let backup_dir = self.backups_dir()?;
        let legacy_location = path.parent() != Some(backup_dir.as_path());
        Self::inspect_backup_path(path, legacy_location).await
    }

    pub async fn list_backups(&self) -> Result<Vec<DatabaseBackup>, String> {
        let parent = self.path.parent().ok_or("database path has no parent")?;
        let backup_dir = self.backups_dir()?;
        let mut paths = Vec::new();
        for (directory, legacy) in [(backup_dir, false), (parent.to_path_buf(), true)] {
            let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
            for entry in entries {
                let path = entry.map_err(|error| error.to_string())?.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if path.extension().and_then(|value| value.to_str()) == Some("db")
                    && (!legacy || name.starts_with("backup_"))
                {
                    paths.push((path, legacy));
                }
            }
        }
        let mut backups = Vec::with_capacity(paths.len());
        for (path, legacy) in paths {
            if let Ok(backup) = Self::inspect_backup_path(path, legacy).await {
                backups.push(backup);
            }
        }
        backups.sort_by(|left, right| right.modified_sec.cmp(&left.modified_sec));
        Ok(backups)
    }
}
