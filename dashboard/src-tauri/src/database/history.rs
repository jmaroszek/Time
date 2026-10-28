//! Deleting recorded activity: previews, targeted deletes, and full erasure.

use super::*;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeleteRequest {
    pub mode: String,
    #[serde(default)]
    pub session_ids: Vec<i64>,
    pub entity_kind: Option<String>,
    pub entity_key: Option<String>,
    pub start_sec: Option<f64>,
    pub end_sec: Option<f64>,
    #[serde(default)]
    pub browser_processes: Vec<String>,
    pub snapshot_max_id: Option<i64>,
    pub preview_protected_session_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeletePreview {
    pub count: u64,
    pub seconds: i64,
    pub earliest_start: Option<i64>,
    pub latest_end: Option<i64>,
    pub protected_count: u64,
    pub snapshot_max_id: i64,
    pub protected_session_id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeleteResult {
    pub deleted_count: u64,
    pub protected_count: u64,
}

#[derive(Clone)]
struct DeletionCandidate {
    id: i64,
    start: i64,
    end: i64,
}

impl TimeDatabase {
    async fn activity_delete_candidates(
        &self,
        request: &ActivityDeleteRequest,
    ) -> Result<Vec<DeletionCandidate>, String> {
        if request.mode == "sessions" {
            if request.session_ids.is_empty() {
                return Err("Select at least one session".into());
            }
            if request.session_ids.len() > 100_000 {
                return Err("Too many sessions selected at once".into());
            }
            let mut unique = request.session_ids.iter().copied().collect::<HashSet<_>>();
            unique.retain(|id| *id > 0);
            let ids = unique.into_iter().collect::<Vec<_>>();
            let mut candidates = Vec::new();
            for chunk in ids.chunks(ID_CHUNK) {
                let placeholders = placeholders(chunk.len(), "?");
                let sql = format!(
                    "SELECT s.id,{EFFECTIVE_SPAN} {CORRECTED_JOIN} \
                     WHERE s.id IN ({placeholders})"
                );
                let mut query = sqlx::query(&sql);
                for id in chunk {
                    query = query.bind(id);
                }
                for row in query
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    candidates.push(DeletionCandidate {
                        id: row.try_get("id").map_err(|error| error.to_string())?,
                        start: row
                            .try_get("effective_start")
                            .map_err(|error| error.to_string())?,
                        end: row
                            .try_get("effective_end")
                            .map_err(|error| error.to_string())?,
                    });
                }
            }
            return Ok(candidates);
        }

        if request.mode != "entity" {
            return Err("Unsupported Activity deletion mode".into());
        }
        let entity_kind = request
            .entity_kind
            .as_deref()
            .ok_or("Missing entity kind")?;
        let entity_key = request
            .entity_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .ok_or("Missing entity key")?
            .to_ascii_lowercase();
        let start_sec = request.start_sec.ok_or("Missing deletion start")?;
        let end_sec = request.end_sec.ok_or("Missing deletion end")?;
        if !start_sec.is_finite() || !end_sec.is_finite() || end_sec <= start_sec {
            return Err("Invalid Activity deletion range".into());
        }
        let browser_processes = request
            .browser_processes
            .iter()
            .map(|process| process.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let predicate = match entity_kind {
            "app" => "lower(s.process)=?",
            "website" => "lower(IFNULL(s.domain,''))=?",
            _ => return Err("Unsupported Activity entity kind".into()),
        };
        let sql = format!(
            "SELECT s.id,{EFFECTIVE_SPAN},s.process,s.domain {CORRECTED_JOIN} \
             WHERE {predicate} AND {OVERLAPS_WINDOW}"
        );
        let rows = sqlx::query(&sql)
            .bind(&entity_key)
            .bind(start_sec)
            .bind(end_sec)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        let mut candidates = Vec::new();
        for row in rows {
            let process = row
                .try_get::<String, _>("process")
                .map_err(|error| error.to_string())?
                .to_ascii_lowercase();
            let domain = row
                .try_get::<Option<String>, _>("domain")
                .map_err(|error| error.to_string())?;
            let has_domain = domain.as_deref().is_some_and(|value| !value.is_empty());
            let belongs = match entity_kind {
                "app" => !browser_processes.contains(&process) || !has_domain,
                "website" => browser_processes.contains(&process) && has_domain,
                _ => false,
            };
            if belongs {
                candidates.push(DeletionCandidate {
                    id: row.try_get("id").map_err(|error| error.to_string())?,
                    start: row
                        .try_get("effective_start")
                        .map_err(|error| error.to_string())?,
                    end: row
                        .try_get("effective_end")
                        .map_err(|error| error.to_string())?,
                });
            }
        }
        Ok(candidates)
    }

    async fn max_session_id(&self) -> Result<i64, String> {
        let row = sqlx::query("SELECT COALESCE(MAX(id),0) AS max_id FROM sessions")
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        row.try_get("max_id").map_err(|error| error.to_string())
    }

    pub async fn preview_activity_delete(
        &self,
        request: &ActivityDeleteRequest,
    ) -> Result<ActivityDeletePreview, String> {
        let snapshot_max_id = self.max_session_id().await?;
        let protected = self.protected_live_session_id().await?;
        let candidates = self.activity_delete_candidates(request).await?;
        let mut count = 0_u64;
        let mut seconds = 0_i64;
        let mut earliest_start: Option<i64> = None;
        let mut latest_end: Option<i64> = None;
        let mut protected_count = 0_u64;
        for candidate in candidates {
            if candidate.id > snapshot_max_id {
                continue;
            }
            if Some(candidate.id) == protected {
                protected_count += 1;
                continue;
            }
            count += 1;
            seconds += (candidate.end - candidate.start).max(0);
            earliest_start =
                Some(earliest_start.map_or(candidate.start, |value| value.min(candidate.start)));
            latest_end = Some(latest_end.map_or(candidate.end, |value| value.max(candidate.end)));
        }
        Ok(ActivityDeletePreview {
            count,
            seconds,
            earliest_start,
            latest_end,
            protected_count,
            snapshot_max_id,
            protected_session_id: protected,
        })
    }

    pub async fn delete_activity(
        &self,
        request: &ActivityDeleteRequest,
    ) -> Result<ActivityDeleteResult, String> {
        self.ensure_writable_schema()?;
        self.record_early_beta().await?;
        let snapshot_max_id = request
            .snapshot_max_id
            .ok_or("Preview Activity deletion before confirming")?;
        let protected = self.protected_live_session_id().await?;
        let preview_protected = request.preview_protected_session_id;
        let candidates = self.activity_delete_candidates(request).await?;
        let mut protected_count = 0_u64;
        let ids = candidates
            .into_iter()
            .filter_map(|candidate| {
                if candidate.id > snapshot_max_id {
                    return None;
                }
                if Some(candidate.id) == protected || Some(candidate.id) == preview_protected {
                    protected_count += 1;
                    return None;
                }
                Some(candidate.id)
            })
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(ActivityDeleteResult {
                deleted_count: 0,
                protected_count,
            });
        }
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        let mut deleted_count = 0_u64;
        for chunk in ids.chunks(ID_CHUNK) {
            let placeholders = placeholders(chunk.len(), "?");
            let sql = format!("DELETE FROM sessions WHERE id IN ({placeholders})");
            let mut query = sqlx::query(&sql);
            for id in chunk {
                query = query.bind(id);
            }
            deleted_count += query
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?
                .rows_affected();
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        self.compact().await?;
        Ok(ActivityDeleteResult {
            deleted_count,
            protected_count,
        })
    }

    pub async fn delete_history_before(&self, cutoff_sec: f64) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        self.record_early_beta().await?;
        if !cutoff_sec.is_finite() {
            return Err("Invalid history cutoff".into());
        }
        let sql = format!(
            "DELETE FROM sessions WHERE id IN (SELECT s.id {CORRECTED_JOIN} \
             WHERE COALESCE(c.corrected_end_ts,s.end_ts) < ?)"
        );
        let result = sqlx::query(&sql)
            .bind(cutoff_sec.floor() as i64)
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        if result.rows_affected() > 0 {
            self.compact().await?;
        }
        Ok(result.rows_affected())
    }

    pub async fn erase_history(&self) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        self.record_early_beta().await?;
        let result = sqlx::query("DELETE FROM sessions")
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        // secure_delete overwrites deleted cells; checkpoint and compact so old
        // title text is not left recoverable in the WAL or free database pages.
        self.compact().await?;
        Ok(result.rows_affected())
    }

    pub(super) async fn compact(&self) -> Result<(), String> {
        self.ensure_writable_schema()?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query("VACUUM")
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
