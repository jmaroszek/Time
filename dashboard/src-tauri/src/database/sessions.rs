//! Recorded sessions as the dashboard reads them, and which one is still being written.

use super::settings::schedule_allows_local;
use super::*;
use chrono::{Datelike, Local, Timelike};
use serde::Serialize;
use sqlx::Row;
use std::time::{SystemTime, UNIX_EPOCH};

// Each scalar bound uses its own index lookup. Choose the shorter time span to
// scan: the start index for early history, the end index for recent history.
// This is a cost heuristic only; both paths retain the exact overlap predicate,
// including arbitrarily long sessions. Corrected rows use their effective span
// independently, since raw bounds cannot say where a correction moved a row.
// CROSS JOIN keeps the one-row choice outside each session scan: a scalar
// WHERE subquery can otherwise walk the unused index before rejecting its rows.
pub(super) const FETCH_SESSIONS_SQL: &str = r#"
WITH scan_choice AS (
    SELECT ?2 - (SELECT MIN(start_ts) FROM sessions)
         < (SELECT MAX(end_ts) FROM sessions) - ?1 AS use_start
)
SELECT s.id,s.start_ts AS effective_start,s.end_ts AS effective_end,
       s.process,s.title,s.domain,s.is_afk,NULL AS category_id,0 AS is_corrected
FROM scan_choice CROSS JOIN sessions s INDEXED BY idx_sessions_start
WHERE use_start AND s.start_ts<?2 AND s.end_ts>?1
  AND NOT EXISTS (SELECT 1 FROM session_corrections c WHERE c.session_id=s.id)
UNION ALL
SELECT s.id,s.start_ts,s.end_ts,s.process,s.title,s.domain,s.is_afk,NULL,0
FROM scan_choice CROSS JOIN sessions s INDEXED BY idx_sessions_end
WHERE NOT use_start AND s.end_ts>?1 AND s.start_ts<?2
  AND NOT EXISTS (SELECT 1 FROM session_corrections c WHERE c.session_id=s.id)
UNION ALL
SELECT s.id,COALESCE(c.corrected_start_ts,s.start_ts),
       COALESCE(c.corrected_end_ts,s.end_ts),s.process,s.title,s.domain,
       s.is_afk,c.category_id,1
FROM session_corrections c JOIN sessions s ON s.id=c.session_id
WHERE COALESCE(c.corrected_end_ts,s.end_ts)>?1
  AND COALESCE(c.corrected_start_ts,s.start_ts)<?2
ORDER BY effective_start ASC,id ASC
"#;

/// Columnar session transport keeps the largest dashboard read compact. The
/// generic SELECT bridge builds a string-keyed JSON map for every row; sending
/// each column once avoids that repeated allocation and repeated field names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionColumns {
    pub(super) ids: Vec<i64>,
    pub(super) starts: Vec<i64>,
    pub(super) ends: Vec<i64>,
    pub(super) processes: Vec<String>,
    pub(super) titles: Vec<String>,
    pub(super) domains: Vec<Option<String>>,
    pub(super) is_afk: Vec<bool>,
    pub(super) category_override_ids: Vec<Option<i64>>,
    pub(super) is_corrected: Vec<bool>,
}

impl TimeDatabase {
    pub async fn fetch_sessions(
        &self,
        start_sec: f64,
        end_sec: f64,
    ) -> Result<SessionColumns, String> {
        if !start_sec.is_finite() || !end_sec.is_finite() || end_sec <= start_sec {
            return Err("Invalid session window".into());
        }
        let rows = sqlx::query(FETCH_SESSIONS_SQL)
            .bind(start_sec)
            .bind(end_sec)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;

        let mut out = SessionColumns {
            ids: Vec::with_capacity(rows.len()),
            starts: Vec::with_capacity(rows.len()),
            ends: Vec::with_capacity(rows.len()),
            processes: Vec::with_capacity(rows.len()),
            titles: Vec::with_capacity(rows.len()),
            domains: Vec::with_capacity(rows.len()),
            is_afk: Vec::with_capacity(rows.len()),
            category_override_ids: Vec::with_capacity(rows.len()),
            is_corrected: Vec::with_capacity(rows.len()),
        };
        for row in rows {
            out.ids
                .push(row.try_get("id").map_err(|error| error.to_string())?);
            out.starts.push(
                row.try_get("effective_start")
                    .map_err(|error| error.to_string())?,
            );
            out.ends.push(
                row.try_get("effective_end")
                    .map_err(|error| error.to_string())?,
            );
            out.processes
                .push(row.try_get("process").map_err(|error| error.to_string())?);
            out.titles
                .push(row.try_get("title").map_err(|error| error.to_string())?);
            out.domains
                .push(row.try_get("domain").map_err(|error| error.to_string())?);
            let is_afk: i64 = row.try_get("is_afk").map_err(|error| error.to_string())?;
            out.is_afk.push(is_afk != 0);
            out.category_override_ids.push(
                row.try_get("category_id")
                    .map_err(|error| error.to_string())?,
            );
            let is_corrected: i64 = row
                .try_get("is_corrected")
                .map_err(|error| error.to_string())?;
            out.is_corrected.push(is_corrected != 0);
        }
        Ok(out)
    }

    pub(super) async fn protected_live_session_id(&self) -> Result<Option<i64>, String> {
        let rows = sqlx::query(
            "SELECT key,value FROM settings WHERE key IN \
             ('recording_consent','tracking_paused','tracking_paused_until','heartbeat_seconds',\
              'tracking_schedule_enabled','tracking_schedule_days',\
              'tracking_schedule_start_minute','tracking_schedule_end_minute')",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let mut consent = false;
        let mut paused = false;
        let mut paused_until = 0_i64;
        let mut heartbeat = 15_i64;
        let mut schedule_enabled = false;
        let mut schedule_days = "0,1,2,3,4".to_string();
        let mut schedule_start = "540".to_string();
        let mut schedule_end = "1020".to_string();
        for row in rows {
            let key: String = row.try_get("key").map_err(|error| error.to_string())?;
            let value: String = row.try_get("value").map_err(|error| error.to_string())?;
            match key.as_str() {
                "recording_consent" => consent = value == "1",
                "tracking_paused" => paused = value == "1",
                "tracking_paused_until" => paused_until = value.parse().unwrap_or(0),
                "heartbeat_seconds" => heartbeat = value.parse().unwrap_or(15),
                "tracking_schedule_enabled" => schedule_enabled = value == "1",
                "tracking_schedule_days" => schedule_days = value,
                "tracking_schedule_start_minute" => schedule_start = value,
                "tracking_schedule_end_minute" => schedule_end = value,
                _ => {}
            }
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs() as i64;
        let local_now = Local::now();
        let schedule_allows = schedule_allows_local(
            schedule_enabled,
            &schedule_days,
            &schedule_start,
            &schedule_end,
            local_now.weekday().num_days_from_monday(),
            local_now.hour() * 60 + local_now.minute(),
        );
        if !consent || paused || paused_until > now || !schedule_allows {
            return Ok(None);
        }
        let row = sqlx::query(
            "SELECT id,end_ts FROM sessions WHERE source='live' \
             ORDER BY start_ts DESC,id DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let Some(row) = row else { return Ok(None) };
        let end: i64 = row.try_get("end_ts").map_err(|error| error.to_string())?;
        let freshness = 120_i64.max(heartbeat.clamp(5, 300) * 4);
        if end < now - freshness {
            return Ok(None);
        }
        row.try_get("id")
            .map(Some)
            .map_err(|error| error.to_string())
    }
}
