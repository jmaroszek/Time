//! Per-session corrections and bulk classification, stored beside the recorded rows.

use super::*;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::HashSet;

const MAX_CORRECTION_SPAN_SEC: i64 = 7 * 86_400;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCorrectionRequest {
    pub session_id: i64,
    pub start_sec: f64,
    pub end_sec: f64,
    pub category_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCorrection {
    pub session_id: i64,
    pub original_start: i64,
    pub original_end: i64,
    pub start: i64,
    pub end: i64,
    pub process: String,
    pub title: String,
    pub domain: Option<String>,
    pub category_id: Option<i64>,
    pub is_afk: bool,
    pub is_live: bool,
    pub is_corrected: bool,
    /// The free gap around this session: the end of the nearest session before
    /// it, and the start of the nearest one after. Corrected times may not
    /// overlap another recording, and because the tracker records continuously
    /// that gap is usually the session's own span — so the interface states the
    /// limit up front rather than letting every edit be rejected after the
    /// fact. `None` means nothing is recorded on that side.
    pub earliest_start: Option<i64>,
    pub latest_end: Option<i64>,
}

/// A category applied to many sessions at once, leaving their recorded times
/// alone. `correct_session` is the one-session form and takes a span with it,
/// which drags in the overlap and future-time checks a reclassification has no
/// business re-running — and would re-run per session, over the whole timeline.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClassificationRequest {
    pub session_ids: Vec<i64>,
    /// `None` clears the override, returning each session to the rules.
    pub category_id: Option<i64>,
}

/// One session's override as it stood before a batch changed it. The caller
/// keeps these to offer an undo; they are the only record of the previous
/// state, since a correction row stores no history of its own.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClassification {
    pub session_id: i64,
    pub category_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClassificationResult {
    pub changed_count: u64,
    /// AFK rows and the live session, which are not editable. Counted rather
    /// than refused: a selection is made over what was on screen, and one
    /// untouchable row in it should not cost the other three hundred.
    pub skipped_count: u64,
    pub previous: Vec<SessionClassification>,
}

impl TimeDatabase {
    pub async fn fetch_session_correction(
        &self,
        session_id: i64,
    ) -> Result<SessionCorrection, String> {
        let sql = format!(
            "SELECT s.id,s.start_ts,s.end_ts,s.process,s.title,s.domain,s.is_afk, \
             {EFFECTIVE_SPAN},c.category_id, \
             c.session_id IS NOT NULL AS is_corrected \
             {CORRECTED_JOIN} WHERE s.id=?"
        );
        let row = sqlx::query(&sql)
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Session no longer exists")?;
        let protected = self.protected_live_session_id().await?;
        let effective_start: i64 = row
            .try_get("effective_start")
            .map_err(|error| error.to_string())?;
        let effective_end: i64 = row
            .try_get("effective_end")
            .map_err(|error| error.to_string())?;
        // Mirrors the overlap test in correct_session, including that it does
        // not exclude AFK rows: a neighbour is anything occupying the clock.
        // Touching endpoints are legal, so these are the exact bounds rather
        // than one second inside them.
        let sql = format!(
            "SELECT (SELECT MAX(COALESCE(c.corrected_end_ts,s.end_ts)) \
               {CORRECTED_JOIN} \
               WHERE s.id<>?1 AND COALESCE(c.corrected_end_ts,s.end_ts)<=?2) AS earliest_start, \
             (SELECT MIN(COALESCE(c.corrected_start_ts,s.start_ts)) \
               {CORRECTED_JOIN} \
               WHERE s.id<>?1 AND COALESCE(c.corrected_start_ts,s.start_ts)>=?3) AS latest_end"
        );
        let bounds = sqlx::query(&sql)
            .bind(session_id)
            .bind(effective_start)
            .bind(effective_end)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(SessionCorrection {
            session_id,
            original_start: row.try_get("start_ts").map_err(|error| error.to_string())?,
            original_end: row.try_get("end_ts").map_err(|error| error.to_string())?,
            start: effective_start,
            end: effective_end,
            process: row.try_get("process").map_err(|error| error.to_string())?,
            title: row.try_get("title").map_err(|error| error.to_string())?,
            domain: row.try_get("domain").map_err(|error| error.to_string())?,
            category_id: row
                .try_get("category_id")
                .map_err(|error| error.to_string())?,
            is_afk: row
                .try_get::<i64, _>("is_afk")
                .map_err(|error| error.to_string())?
                != 0,
            is_live: protected == Some(session_id),
            is_corrected: row
                .try_get::<i64, _>("is_corrected")
                .map_err(|error| error.to_string())?
                != 0,
            earliest_start: bounds
                .try_get("earliest_start")
                .map_err(|error| error.to_string())?,
            latest_end: bounds
                .try_get("latest_end")
                .map_err(|error| error.to_string())?,
        })
    }

    pub async fn correct_session(
        &self,
        request: &SessionCorrectionRequest,
    ) -> Result<SessionCorrection, String> {
        self.ensure_writable_schema()?;
        if !request.start_sec.is_finite() || !request.end_sec.is_finite() {
            return Err("Session times must be finite".into());
        }
        let start = request.start_sec.floor() as i64;
        let end = request.end_sec.floor() as i64;
        if end <= start {
            return Err("Session end must be after its start".into());
        }
        if end - start > MAX_CORRECTION_SPAN_SEC {
            return Err("A corrected session cannot be longer than seven days".into());
        }
        if end > unix_now()? {
            return Err("A corrected session cannot end in the future".into());
        }
        let original = sqlx::query("SELECT start_ts,end_ts,is_afk FROM sessions WHERE id=?")
            .bind(request.session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Session no longer exists")?;
        if original
            .try_get::<i64, _>("is_afk")
            .map_err(|error| error.to_string())?
            != 0
        {
            return Err("AFK sessions cannot be edited".into());
        }
        if self.protected_live_session_id().await? == Some(request.session_id) {
            return Err("The current live session cannot be edited".into());
        }
        if let Some(category_id) = request.category_id {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories WHERE id=?")
                .bind(category_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
            if exists == 0 {
                return Err("The selected category no longer exists".into());
            }
        }
        let sql = format!("SELECT COUNT(*) {CORRECTED_JOIN} WHERE s.id<>? AND {OVERLAPS_WINDOW}");
        let overlaps: i64 = sqlx::query_scalar(&sql)
            .bind(request.session_id)
            .bind(start)
            .bind(end)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        if overlaps > 0 {
            return Err("Corrected times overlap another recorded session".into());
        }
        let original_start: i64 = original
            .try_get("start_ts")
            .map_err(|error| error.to_string())?;
        let original_end: i64 = original
            .try_get("end_ts")
            .map_err(|error| error.to_string())?;
        if start == original_start && end == original_end && request.category_id.is_none() {
            sqlx::query("DELETE FROM session_corrections WHERE session_id=?")
                .bind(request.session_id)
                .execute(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            let corrected_start = (start != original_start || end != original_end).then_some(start);
            let corrected_end = (start != original_start || end != original_end).then_some(end);
            sqlx::query(
                "INSERT INTO session_corrections \
                 (session_id,corrected_start_ts,corrected_end_ts,category_id,updated_ts) \
                 VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET \
                 corrected_start_ts=excluded.corrected_start_ts, \
                 corrected_end_ts=excluded.corrected_end_ts,category_id=excluded.category_id, \
                 updated_ts=excluded.updated_ts",
            )
            .bind(request.session_id)
            .bind(corrected_start)
            .bind(corrected_end)
            .bind(request.category_id)
            .bind(unix_now()?)
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        }
        self.fetch_session_correction(request.session_id).await
    }

    pub async fn reset_session_correction(&self, session_id: i64) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        if self.protected_live_session_id().await? == Some(session_id) {
            return Err("The current live session cannot be edited".into());
        }
        sqlx::query("DELETE FROM session_corrections WHERE session_id=?")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map(|result| result.rows_affected())
            .map_err(|error| error.to_string())
    }

    /// Applies one category to many sessions, or clears theirs.
    ///
    /// Recorded times are never touched, so an existing time correction on a
    /// reclassified session survives — which is why the upsert names only the
    /// two columns it owns instead of writing the whole row.
    pub async fn classify_sessions(
        &self,
        request: &SessionClassificationRequest,
    ) -> Result<SessionClassificationResult, String> {
        self.ensure_writable_schema()?;
        if request.session_ids.is_empty() {
            return Err("Select at least one session".into());
        }
        if request.session_ids.len() > 100_000 {
            return Err("Too many sessions selected at once".into());
        }
        if let Some(category_id) = request.category_id {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories WHERE id=?")
                .bind(category_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|error| error.to_string())?;
            if exists == 0 {
                return Err("The selected category no longer exists".into());
            }
        }
        let mut unique = request.session_ids.iter().copied().collect::<HashSet<_>>();
        unique.retain(|id| *id > 0);
        let ids = unique.into_iter().collect::<Vec<_>>();
        let protected = self.protected_live_session_id().await?;

        // Reading the prior state first serves two purposes: it is the undo the
        // result carries, and it is what decides which sessions are actually
        // changing — a session already in the target category is not a change,
        // and counting it as one would make the confirmation a lie.
        let mut skipped_count = 0_u64;
        let mut previous = Vec::new();
        let mut writable = Vec::new();
        for chunk in ids.chunks(ID_CHUNK) {
            let placeholders = placeholders(chunk.len(), "?");
            let sql = format!(
                "SELECT s.id,s.is_afk,c.category_id,c.corrected_start_ts {CORRECTED_JOIN} \
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
                let id: i64 = row.try_get("id").map_err(|error| error.to_string())?;
                let is_afk: i64 = row.try_get("is_afk").map_err(|error| error.to_string())?;
                if is_afk != 0 || Some(id) == protected {
                    skipped_count += 1;
                    continue;
                }
                let category_id: Option<i64> = row
                    .try_get("category_id")
                    .map_err(|error| error.to_string())?;
                if category_id == request.category_id {
                    continue;
                }
                let corrected_start: Option<i64> = row
                    .try_get("corrected_start_ts")
                    .map_err(|error| error.to_string())?;
                previous.push(SessionClassification {
                    session_id: id,
                    category_id,
                });
                writable.push((id, corrected_start.is_some()));
            }
        }
        if writable.is_empty() {
            return Ok(SessionClassificationResult {
                changed_count: 0,
                skipped_count,
                previous,
            });
        }

        let now = unix_now()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        let mut changed_count = 0_u64;
        if let Some(category_id) = request.category_id {
            for chunk in writable.chunks(ID_CHUNK) {
                let values = placeholders(chunk.len(), "(?,NULL,NULL,?,?)");
                // Only the two columns this call owns. `excluded` would carry
                // the NULL times above into an existing row and silently drop a
                // correction someone made to the clock.
                let sql = format!(
                    "INSERT INTO session_corrections \
                     (session_id,corrected_start_ts,corrected_end_ts,category_id,updated_ts) \
                     VALUES {values} ON CONFLICT(session_id) DO UPDATE SET \
                     category_id=excluded.category_id,updated_ts=excluded.updated_ts"
                );
                let mut query = sqlx::query(&sql);
                for (id, _) in chunk {
                    query = query.bind(id).bind(category_id).bind(now);
                }
                changed_count += query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected();
            }
        } else {
            // Clearing leaves a row behind only where it still carries a time
            // correction. An override-only row with no category is what
            // correct_session deletes rather than store, and an empty row here
            // would report a session as corrected forever after.
            let (timed, bare): (Vec<_>, Vec<_>) =
                writable.iter().partition(|(_, has_times)| *has_times);
            for chunk in timed.chunks(ID_CHUNK) {
                let placeholders = placeholders(chunk.len(), "?");
                let sql = format!(
                    "UPDATE session_corrections SET category_id=NULL,updated_ts=? \
                     WHERE session_id IN ({placeholders})"
                );
                let mut query = sqlx::query(&sql).bind(now);
                for (id, _) in chunk {
                    query = query.bind(id);
                }
                changed_count += query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected();
            }
            for chunk in bare.chunks(ID_CHUNK) {
                let placeholders = placeholders(chunk.len(), "?");
                let sql =
                    format!("DELETE FROM session_corrections WHERE session_id IN ({placeholders})");
                let mut query = sqlx::query(&sql);
                for (id, _) in chunk {
                    query = query.bind(id);
                }
                changed_count += query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|error| error.to_string())?
                    .rows_affected();
            }
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        Ok(SessionClassificationResult {
            changed_count,
            skipped_count,
            previous,
        })
    }
}
