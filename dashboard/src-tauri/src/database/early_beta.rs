//! The marker that an install began during the early beta.
//!
//! Anyone whose first recorded activity falls on or before 28 October 2026
//! was told they would never be asked to pay for Time. A paid release has to
//! answer that from something history deletion cannot take away, so the
//! answer is written once into `settings` as `early_beta` and never cleared:
//! Restore defaults leaves it alone, and every path that deletes sessions
//! records it first. It holds `1` and nothing else, so it says no more about
//! the user's history than which side of the cutoff it began on.

use super::*;
use chrono::{Local, TimeZone, Utc};

pub(crate) const EARLY_BETA_KEY: &str = "early_beta";

/// The first second after the cutoff day, in the machine's own time zone.
fn cutoff_ts() -> i64 {
    // Midnight is skipped in a few zones' daylight-saving changes; 1 am is
    // never skipped by the same change.
    [0, 1]
        .into_iter()
        .find_map(|hour| Local.with_ymd_and_hms(2026, 10, 29, hour, 0, 0).earliest())
        .map(|moment| moment.timestamp())
        .unwrap_or_else(|| {
            Utc.with_ymd_and_hms(2026, 10, 29, 0, 0, 0)
                .unwrap()
                .timestamp()
        })
}

impl TimeDatabase {
    /// Write the marker when the earliest session predates the cutoff.
    /// Idempotent, and a no-op once the marker exists or for a later install.
    pub(crate) async fn record_early_beta(&self) -> Result<(), String> {
        self.ensure_writable_schema()?;
        sqlx::query(
            "INSERT OR IGNORE INTO settings (key,value) \
             SELECT ?,'1' WHERE EXISTS (SELECT 1 FROM sessions WHERE start_ts < ?)",
        )
        .bind(EARLY_BETA_KEY)
        .bind(cutoff_ts())
        .execute(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn early_beta_cutoff_ts() -> i64 {
        cutoff_ts()
    }
}
