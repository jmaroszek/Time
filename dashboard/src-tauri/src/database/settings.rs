//! Settings the renderer may write, the lifecycle settings only native code writes, and
//! the defaults a restore puts back.

use super::*;
use serde::Deserialize;
use sqlx::Row;
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

/// Keys the renderer may persist directly.  Lifecycle-owned state is
/// intentionally absent: consent, startup registration, scheduling and pause
/// flags have cross-system invariants and must travel through the native
/// lifecycle command instead of an arbitrary SQL-shaped write.
const RENDERER_SETTING_KEYS: &[&str] = &[
    "weekly_goal_hours",
    "idle_threshold_seconds",
    "heartbeat_seconds",
    "week_start",
    "browser_processes",
    "min_app_seconds_per_day",
    "media_domains",
    "activity_noise_filter",
    "activity_noise_max_seconds",
    "activity_noise_max_sessions",
    "color_palette",
    "productivity_style",
    "theme",
    "focus_chain_max_gap_seconds",
    "day_start_hour",
    "day_end_hour",
    "record_window_titles",
    "record_browser_domains",
    "show_tray_icon",
    "check_updates_automatically",
    "process_aliases",
    "starter_categories_pending",
    "starter_suggestions_dismissed",
    "rule_consolidation_dismissed",
    "window_rules_reset_v4_pending",
    "website_signal_seen",
    "website_rule_guidance_seen",
    "domain_coverage_hint_dismissed",
    "welcome_dismissed",
    "recording_off_notice_dismissed",
    "off_schedule_notice_dismissed",
    "feedback_prompts_enabled",
    "app_feedback_prompt_state",
    "extension_review_prompt_state",
    "feedback_prompt_last_shown",
];

/// Values reset by the native Restore defaults action.  Keep this list in
/// lockstep with `DEFAULT_SETTINGS` in tracker/db.py and the dashboard's
/// displayed defaults; history, organization and metadata are deliberately
/// not represented here.
const RESTORE_DEFAULT_SETTINGS: &[(&str, &str)] = &[
    ("weekly_goal_hours", "0"),
    ("idle_threshold_seconds", "300"),
    ("heartbeat_seconds", "15"),
    ("week_start", "auto"),
    (
        "browser_processes",
        "chrome.exe,msedge.exe,firefox.exe,opera.exe,brave.exe,vivaldi.exe",
    ),
    ("min_app_seconds_per_day", "0"),
    ("media_domains", ""),
    ("activity_noise_filter", "utilities_only"),
    ("activity_noise_max_seconds", "120"),
    ("activity_noise_max_sessions", "1"),
    ("color_palette", "slate"),
    ("productivity_style", "vivid"),
    ("theme", "system"),
    ("focus_chain_max_gap_seconds", "300"),
    ("day_start_hour", "0"),
    ("day_end_hour", "24"),
    ("tracking_paused", "0"),
    ("tracking_paused_until", "0"),
    ("tracking_schedule_enabled", "0"),
    ("tracking_schedule_days", "0,1,2,3,4"),
    ("tracking_schedule_start_minute", "540"),
    ("tracking_schedule_end_minute", "1020"),
    ("recording_consent", "0"),
    ("record_window_titles", "0"),
    ("record_browser_domains", "1"),
    ("launch_at_login", "0"),
    ("show_tray_icon", "1"),
    ("check_updates_automatically", "1"),
    ("feedback_prompts_enabled", "1"),
];

fn schedule_minute(raw: &str, fallback: u32) -> u32 {
    raw.parse::<u32>()
        .ok()
        .filter(|minute| *minute < 24 * 60)
        .unwrap_or(fallback)
}

pub(super) fn schedule_allows_local(
    enabled: bool,
    days_raw: &str,
    start_raw: &str,
    end_raw: &str,
    weekday: u32,
    minute: u32,
) -> bool {
    if !enabled {
        return true;
    }
    let days = days_raw
        .split(',')
        .filter_map(|value| value.trim().parse::<u32>().ok())
        .filter(|day| *day <= 6)
        .collect::<HashSet<_>>();
    let start = schedule_minute(start_raw, 9 * 60);
    let end = schedule_minute(end_raw, 17 * 60);
    if days.is_empty() || start == end {
        return false;
    }
    if start < end {
        days.contains(&weekday) && start <= minute && minute < end
    } else {
        (days.contains(&weekday) && minute >= start)
            || (days.contains(&((weekday + 6) % 7)) && minute < end)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingUpdate {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct LifecycleSettings {
    pub recording_consent: bool,
    pub launch_at_login: bool,
    pub schedule_enabled: bool,
    pub tracking_paused: bool,
    pub tracking_paused_value: String,
    pub tracking_paused_until: String,
}

impl TimeDatabase {
    pub(super) fn validate_renderer_setting_key(key: &str) -> Result<(), String> {
        if RENDERER_SETTING_KEYS.contains(&key) {
            return Ok(());
        }
        Err(format!(
            "Setting {key:?} must be changed through its native lifecycle action"
        ))
    }

    async fn write_settings_transaction(&self, updates: &[(String, String)]) -> Result<(), String> {
        self.ensure_writable_schema()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        for (key, value) in updates {
            sqlx::query(
                "INSERT INTO settings (key,value) VALUES (?,?) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .bind(key)
            .bind(value)
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())
    }

    /// Persist ordinary renderer-owned preferences in one transaction.  All
    /// keys are checked before the transaction starts, so a mixed batch can
    /// never partially update settings before a protected or unknown key is
    /// rejected.
    pub async fn update_user_settings(&self, updates: &[SettingUpdate]) -> Result<(), String> {
        let owned = updates
            .iter()
            .map(|update| {
                Self::validate_renderer_setting_key(&update.key)?;
                if update.value.len() > 1_048_576 {
                    return Err(format!("Setting {:?} is too large", update.key));
                }
                Ok((update.key.clone(), update.value.clone()))
            })
            .collect::<Result<Vec<_>, String>>()?;
        self.write_settings_transaction(&owned).await
    }

    /// Native lifecycle actions use the same transaction primitive but may
    /// touch protected state after their invariants have been checked.
    pub(crate) async fn update_lifecycle_settings(
        &self,
        updates: &[(&str, &str)],
    ) -> Result<(), String> {
        self.write_settings_transaction(
            &updates
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect::<Vec<_>>(),
        )
        .await
    }

    pub(crate) async fn lifecycle_settings(&self) -> Result<LifecycleSettings, String> {
        let rows = sqlx::query(
            "SELECT key,value FROM settings WHERE key IN \
             ('recording_consent','launch_at_login','tracking_schedule_enabled',\
              'tracking_paused','tracking_paused_until')",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let mut state = LifecycleSettings::default();
        for row in rows {
            let key: String = row.try_get("key").map_err(|error| error.to_string())?;
            let value: String = row.try_get("value").map_err(|error| error.to_string())?;
            match key.as_str() {
                "recording_consent" => state.recording_consent = value == "1",
                "launch_at_login" => state.launch_at_login = value == "1",
                "tracking_schedule_enabled" => state.schedule_enabled = value == "1",
                "tracking_paused" => {
                    state.tracking_paused = value == "1";
                    state.tracking_paused_value = value;
                }
                "tracking_paused_until" => state.tracking_paused_until = value,
                _ => {}
            }
        }
        Ok(state)
    }

    /// Whether the tracker's own health stamp is older than `stale_after_secs`.
    ///
    /// The stamp is epoch seconds, written by the tracker roughly every five
    /// seconds and deliberately zeroed on a clean shutdown.  Missing,
    /// unparsable, and zero all answer the same question the same way — no
    /// tracker has claimed to be working recently — so none of them is treated
    /// as a reason to leave a silent process alone.
    ///
    /// A stamp in the future is not stale.  It means the clock moved, which is
    /// not evidence about the tracker, and reading it as staleness would make
    /// a daylight-saving change look like a dead process.
    pub(crate) async fn tracker_health_is_stale(
        &self,
        stale_after_secs: i64,
    ) -> Result<bool, String> {
        let raw = sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key='tracker_health_heartbeat'",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        let Some(stamp) = raw.and_then(|value| value.trim().parse::<i64>().ok()) else {
            return Ok(true);
        };
        if stamp <= 0 {
            return Ok(true);
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs() as i64;
        Ok(now.saturating_sub(stamp) >= stale_after_secs)
    }

    pub(crate) async fn restore_default_settings(&self) -> Result<(), String> {
        self.write_settings_transaction(
            &RESTORE_DEFAULT_SETTINGS
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect::<Vec<_>>(),
        )
        .await
    }
}
