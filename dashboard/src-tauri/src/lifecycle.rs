use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Mutex;

use crate::database::{LifecycleSettings, TimeDatabase};

/// One native gate for all renderer-visible settings and tracker lifecycle
/// operations.  SQLite transactions protect individual writes; this mutex is
/// what keeps a concurrent renderer request from interleaving its external
/// tracker/startup side effects with another request.
#[derive(Clone, Default)]
pub(crate) struct LifecycleCoordinator {
    gate: Arc<Mutex<()>>,
}

impl LifecycleCoordinator {
    pub(crate) fn gate(&self) -> &Mutex<()> {
        &self.gate
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum TrackingLifecycleAction {
    #[serde(rename_all = "camelCase")]
    CompleteOnboarding {
        #[serde(default)]
        enable: bool,
        #[serde(default)]
        record_window_titles: bool,
        #[serde(default)]
        start_at_login: bool,
    },
    #[serde(rename_all = "camelCase")]
    SetRecording {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    SetStartup {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    SetSchedule {
        enabled: bool,
        #[serde(default)]
        days: Option<String>,
        #[serde(default)]
        start_minute: Option<u32>,
        #[serde(default)]
        end_minute: Option<u32>,
    },
    Resume,
    EnsureStarted,
    RestoreDefaults,
    SecureErase,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleResult {
    pub recording_consent: bool,
    pub launch_at_login: bool,
    pub schedule_enabled: bool,
    pub tracker_started: bool,
    pub deleted_count: u64,
}

/// The small system surface lifecycle orchestration needs.  Tests inject a
/// fake implementation, so no process or registry call is made by native
/// unit tests while the production command still uses the real helpers.
pub(crate) trait TrackingSystem: Send + Sync {
    fn start(&self) -> Result<(), String>;
    fn stop(&self) -> Result<(), String>;
    fn set_startup(&self, enabled: bool) -> Result<(), String>;
    fn startup_is_registered(&self) -> Result<bool, String>;
    fn is_running(&self) -> Result<bool, String>;
}

pub(crate) struct RealTrackingSystem;

impl TrackingSystem for RealTrackingSystem {
    fn start(&self) -> Result<(), String> {
        crate::system_start_tracker()
    }

    fn stop(&self) -> Result<(), String> {
        crate::system_stop_tracker()
    }

    fn set_startup(&self, enabled: bool) -> Result<(), String> {
        crate::system_set_launch_at_login(enabled)
    }

    fn startup_is_registered(&self) -> Result<bool, String> {
        crate::system_startup_is_registered()
    }

    fn is_running(&self) -> Result<bool, String> {
        crate::system_tracker_is_running()
    }
}

fn result_from(
    settings: LifecycleSettings,
    tracker_started: bool,
    deleted_count: u64,
) -> LifecycleResult {
    LifecycleResult {
        recording_consent: settings.recording_consent,
        launch_at_login: settings.launch_at_login,
        schedule_enabled: settings.schedule_enabled,
        tracker_started,
        deleted_count,
    }
}

async fn current_result(
    database: &TimeDatabase,
    tracker_started: bool,
    deleted_count: u64,
) -> Result<LifecycleResult, String> {
    Ok(result_from(
        database.lifecycle_settings().await?,
        tracker_started,
        deleted_count,
    ))
}

async fn compensate_disabled(database: &TimeDatabase, system: &dyn TrackingSystem) {
    // Compensation is deliberately best-effort.  The original failure is
    // more useful to the caller, while every step here errs toward no future
    // recording and no startup entry.
    let _ = database
        .update_lifecycle_settings(&[
            ("recording_consent", "0"),
            ("launch_at_login", "0"),
            ("tracking_schedule_enabled", "0"),
            ("tracking_paused", "0"),
            ("tracking_paused_until", "0"),
        ])
        .await;
    let _ = system.set_startup(false);
    // A start call can fail after creating the child process.  Best-effort
    // cleanup keeps the fail-closed database state from coexisting with a
    // tracker that can still emit heartbeats.
    let _ = system.stop();
}

async fn compensate_startup_registration(system: &dyn TrackingSystem) {
    // Registration may have partially succeeded before returning an error;
    // this rollback deliberately leaves recording consent untouched.
    let _ = system.set_startup(false);
}

/// Put back the lifecycle state a failed enable found, rather than a
/// fail-closed state nobody chose.
///
/// `compensate_disabled` is right where the prior state really was "off" —
/// onboarding, which runs once on a database that has never consented. Anywhere
/// else it overshoots: it zeroes startup registration and the schedule too, so
/// one failed process launch silently retired settings the reader had
/// configured and would have to notice were gone before they could restore
/// them. Failing to start records nothing either way, so nothing is gained by
/// spending the rest of their configuration on it.
async fn compensate_to_previous(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
    previous: &LifecycleSettings,
) {
    // Best-effort, like every compensation here: the original failure is the
    // useful one to return, and each step below moves toward the state that
    // existed before the call rather than away from it.
    let _ = restore_lifecycle_settings(database, previous).await;
    // Asserted rather than undone, using the same formula
    // `reconcile_startup_registration` applies at launch. Writing what the
    // restored state implies is idempotent, needs no record of what this call
    // changed, and repairs a registration that had already drifted.
    let _ = system.set_startup(previous.recording_consent && previous.launch_at_login);
    if !previous.recording_consent {
        // A start can fail after the child process exists, and the state being
        // restored is one where nothing should be recording. Skipped when
        // consent survives: there the tracker is meant to be running, and
        // stopping it would turn a failed launch into a stopped one.
        let _ = system.stop();
    }
}

/// How stale the tracker's health stamp must be before a live process counts as
/// one that has stopped answering.
///
/// Mirrors `TRACKER_ALERT_STALE_SECONDS` in `dashboard/src/lib/trackerHealth.ts`,
/// which is what decides to raise the banner whose button arrives here.
/// `scripts/tests/test_tracker_health_parity.py` fails if the two drift, because
/// a native threshold above the renderer's would put the banner's own button
/// back to doing nothing in exactly the state the banner exists for.
const TRACKER_UNRESPONSIVE_SECONDS: i64 = 120;

/// Make a tracker that is actually recording exist, replacing one that is not.
///
/// A live process is not evidence of a working tracker. `tracker/tracker.py`
/// wraps its whole tick in one `except Exception`, and the health stamp is
/// written inside that guard and before the probe runs, so a persistent failure
/// in the settings read or the power-event drain leaves the loop spinning
/// forever: stamping nothing, recording nothing, and still listed under its own
/// image name.
///
/// That is precisely the state the "Time has stopped recording" banner is
/// raised for — it reads staleness, never the process list — and the banner's
/// button lands here. Returning early on `is_running` alone made that button a
/// no-op in the one case it exists for, leaving an undismissable alarm on every
/// tab whose only escape was toggling recording off and on. That escape is not
/// free either: turning recording off clears start at sign-in and the schedule,
/// and turning it back on does not restore them, so the only available recovery
/// silently charged the reader two settings to fix a third.
///
/// Replacing a tracker that is merely slow to boot costs a few seconds of
/// recording, and only when somebody is holding the button down. Leaving a
/// wedged one costs every day until they notice by hand.
async fn ensure_recording_tracker(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
) -> Result<bool, String> {
    if !system.is_running()? {
        system.start()?;
        return Ok(true);
    }
    if !database
        .tracker_health_is_stale(TRACKER_UNRESPONSIVE_SECONDS)
        .await?
    {
        return Ok(false);
    }
    system.stop()?;
    // Same confirmation `stop_and_unregister` makes, and for the same reason:
    // Windows can keep the process alive briefly while its handles close, and
    // starting a replacement before the old one is gone leaves two trackers
    // writing to one database.
    if system.is_running()? {
        return Err("The tracker is still running after stop".into());
    }
    system.start()?;
    Ok(true)
}

async fn stop_and_unregister(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
) -> Result<(), String> {
    let mut first_error = None;
    if let Err(error) = system.set_startup(false) {
        first_error = Some(error);
    }
    if let Err(error) = system.stop() {
        if first_error.is_none() {
            first_error = Some(error);
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    // A successful task-kill is not enough for secure erase: Windows may keep
    // the process alive briefly while its handles close.  Confirm the process
    // is gone before a caller proceeds with its next lifecycle step.
    if system.is_running()? {
        return Err("The tracker is still running after stop".into());
    }
    let _ = database;
    Ok(())
}

async fn set_recording(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
    enabled: bool,
) -> Result<LifecycleResult, String> {
    let before = database.lifecycle_settings().await?;
    if !enabled {
        // Persist the fail-closed state before touching either external
        // system.  A crash between these steps must not leave consent saying
        // that a tracker should keep recording or return after reboot.
        database
            .update_lifecycle_settings(&[
                ("recording_consent", "0"),
                ("launch_at_login", "0"),
                ("tracking_schedule_enabled", "0"),
                ("tracking_paused", "0"),
                ("tracking_paused_until", "0"),
            ])
            .await?;
        stop_and_unregister(database, system).await?;
        return current_result(database, false, 0).await;
    }

    let startup_required = before.schedule_enabled;
    let registered_startup = startup_required && !before.launch_at_login;
    if registered_startup {
        // Startup is an external side effect, so compensate it if either the
        // database commit or process launch fails below.
        if let Err(error) = system.set_startup(true) {
            compensate_to_previous(database, system, &before).await;
            return Err(error);
        }
    }

    let mut updates = vec![("recording_consent", "1")];
    if startup_required {
        updates.push(("launch_at_login", "1"));
    }
    if let Err(error) = database.update_lifecycle_settings(&updates).await {
        compensate_to_previous(database, system, &before).await;
        return Err(error);
    }
    let tracker_started = match ensure_recording_tracker(database, system).await {
        Ok(started) => started,
        Err(error) => {
            compensate_to_previous(database, system, &before).await;
            return Err(error);
        }
    };
    current_result(database, tracker_started, 0).await
}

async fn set_startup(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
    enabled: bool,
) -> Result<LifecycleResult, String> {
    let before = database.lifecycle_settings().await?;
    if enabled {
        if !before.recording_consent {
            return Err("Start at sign-in requires recording consent".into());
        }
        // Deliberately no early return when the database already says on.
        // That is exactly the state a lost Run value leaves behind, and it is
        // the state in which someone reaches for this switch: returning here
        // reported success and touched nothing, so the one obvious repair did
        // nothing at all.  Writing the registration again is idempotent.
        if let Err(error) = system.set_startup(true) {
            compensate_startup_registration(system).await;
            return Err(error);
        }
        if let Err(error) = database
            .update_lifecycle_settings(&[("launch_at_login", "1")])
            .await
        {
            compensate_startup_registration(system).await;
            return Err(error);
        }
    } else {
        if before.schedule_enabled {
            return Err("Start at sign-in cannot be disabled while scheduling is on".into());
        }
        database
            .update_lifecycle_settings(&[("launch_at_login", "0")])
            .await?;
        system.set_startup(false)?;
    }
    current_result(database, false, 0).await
}

/// Bring Windows startup registration back in line with the database.
///
/// Every path through this module writes the registry and the database together
/// and compensates in both directions, so the two cannot diverge through the
/// application.  They diverge from outside it: an in-place upgrade runs the
/// previous version's uninstaller, and a rebuilt or swapped Windows profile
/// carries none of the old one's Run values.  Afterwards the database still says
/// on, which is what Settings shows, while nothing will start at the next
/// sign-in -- and for a background recorder that failure has no symptom beyond
/// a day that looks like a day nobody used the computer.
///
/// Reconciling at launch makes the registration self-correcting whatever removed
/// it, rather than correct for the one cause that was found first.
/// `recording_consent` is part of the comparison for the same reason restore
/// applies it: registration is only ever authorized by consent, so a database
/// carrying one without the other must not be read as permission to register.
///
/// Returns whether anything had to be written.
pub(crate) async fn reconcile_startup_registration(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
) -> Result<bool, String> {
    let settings = database.lifecycle_settings().await?;
    let wanted = settings.recording_consent && settings.launch_at_login;
    if system.startup_is_registered()? == wanted {
        return Ok(false);
    }
    system.set_startup(wanted)?;
    Ok(true)
}

fn validate_schedule(
    days: Option<&str>,
    start_minute: Option<u32>,
    end_minute: Option<u32>,
) -> Result<(), String> {
    if let Some(days) = days {
        let valid_days = !days.is_empty()
            && days
                .split(',')
                .all(|day| !day.is_empty() && day.parse::<u32>().is_ok_and(|value| value <= 6));
        if !valid_days {
            return Err("Schedule days are invalid".into());
        }
    }
    for minute in [start_minute, end_minute].into_iter().flatten() {
        if minute >= 24 * 60 {
            return Err("Schedule times must be valid minutes in the day".into());
        }
    }
    if let (Some(start), Some(end)) = (start_minute, end_minute) {
        if start == end {
            return Err("Schedule start and end must be different valid times".into());
        }
    }
    Ok(())
}

async fn set_schedule(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
    enabled: bool,
    days: Option<String>,
    start_minute: Option<u32>,
    end_minute: Option<u32>,
) -> Result<LifecycleResult, String> {
    if enabled && (days.is_none() || start_minute.is_none() || end_minute.is_none()) {
        return Err("Enabled schedules require days, start time, and end time".into());
    }
    if !enabled
        && (days.is_some() || start_minute.is_some() || end_minute.is_some())
        && (days.is_none() || start_minute.is_none() || end_minute.is_none())
    {
        return Err("Schedule days and times must be provided together".into());
    }
    validate_schedule(days.as_deref(), start_minute, end_minute)?;
    let before = database.lifecycle_settings().await?;
    if enabled && !before.recording_consent {
        return Err("Recording consent is required for scheduling".into());
    }
    if !enabled {
        let mut updates = vec![("tracking_schedule_enabled", "0")];
        if let (Some(days), Some(start_minute), Some(end_minute)) =
            (days.as_deref(), start_minute, end_minute)
        {
            let start_string = start_minute.to_string();
            let end_string = end_minute.to_string();
            updates.push(("tracking_schedule_days", days));
            updates.push(("tracking_schedule_start_minute", &start_string));
            updates.push(("tracking_schedule_end_minute", &end_string));
            database.update_lifecycle_settings(&updates).await?;
        } else {
            database.update_lifecycle_settings(&updates).await?;
        }
        return current_result(database, false, 0).await;
    }

    let registered = !before.launch_at_login;
    if registered {
        if let Err(error) = system.set_startup(true) {
            compensate_startup_registration(system).await;
            return Err(error);
        }
    }
    let mut updates = vec![("tracking_schedule_enabled", "1")];
    if registered {
        updates.push(("launch_at_login", "1"));
    }
    let days_string = days
        .as_deref()
        .ok_or("Enabled schedules require days, start time, and end time")?;
    let start_string = start_minute
        .map(|value| value.to_string())
        .ok_or("Enabled schedules require days, start time, and end time")?;
    let end_string = end_minute
        .map(|value| value.to_string())
        .ok_or("Enabled schedules require days, start time, and end time")?;
    updates.push(("tracking_schedule_days", days_string));
    updates.push(("tracking_schedule_start_minute", &start_string));
    updates.push(("tracking_schedule_end_minute", &end_string));
    if let Err(error) = database.update_lifecycle_settings(&updates).await {
        if registered {
            compensate_startup_registration(system).await;
        }
        return Err(error);
    }
    current_result(database, false, 0).await
}

async fn complete_onboarding(
    database: &TimeDatabase,
    system: &dyn TrackingSystem,
    enable: bool,
    record_window_titles: bool,
    start_at_login: bool,
) -> Result<LifecycleResult, String> {
    let title_value = if enable && record_window_titles {
        "1"
    } else {
        "0"
    };
    if !enable {
        database
            .update_lifecycle_settings(&[
                ("privacy_onboarding_complete", "1"),
                ("record_window_titles", title_value),
                ("recording_consent", "0"),
                ("launch_at_login", "0"),
                ("tracking_schedule_enabled", "0"),
                ("tracking_paused", "0"),
                ("tracking_paused_until", "0"),
            ])
            .await?;
        stop_and_unregister(database, system).await?;
        return current_result(database, false, 0).await;
    }

    if start_at_login {
        if let Err(error) = system.set_startup(true) {
            compensate_disabled(database, system).await;
            return Err(error);
        }
    } else if let Err(error) = system.set_startup(false) {
        compensate_disabled(database, system).await;
        return Err(error);
    }
    let startup_value = if start_at_login { "1" } else { "0" };
    if let Err(error) = database
        .update_lifecycle_settings(&[
            // Do not mark onboarding complete until the tracker has been
            // confirmed below.  A failed launch must return the reader to the
            // consent screen rather than leaving a half-configured install
            // looking finished on the next refresh.
            ("privacy_onboarding_complete", "0"),
            ("record_window_titles", title_value),
            ("recording_consent", "1"),
            ("launch_at_login", startup_value),
            ("tracking_schedule_enabled", "0"),
        ])
        .await
    {
        compensate_disabled(database, system).await;
        return Err(error);
    }
    // The one caller where `compensate_disabled` is not an overshoot: this runs
    // on a database that has never consented, so the state it forces is the
    // state that was already there.
    let tracker_started = match ensure_recording_tracker(database, system).await {
        Ok(started) => started,
        Err(error) => {
            compensate_disabled(database, system).await;
            return Err(error);
        }
    };
    if let Err(error) = database
        .update_lifecycle_settings(&[("privacy_onboarding_complete", "1")])
        .await
    {
        compensate_disabled(database, system).await;
        return Err(error);
    }
    current_result(database, tracker_started, 0).await
}

async fn restore_lifecycle_settings(
    database: &TimeDatabase,
    settings: &LifecycleSettings,
) -> Result<(), String> {
    let consent = if settings.recording_consent { "1" } else { "0" };
    let startup = if settings.launch_at_login { "1" } else { "0" };
    let schedule = if settings.schedule_enabled { "1" } else { "0" };
    let paused = if settings.tracking_paused_value.is_empty() {
        if settings.tracking_paused {
            "1"
        } else {
            "0"
        }
    } else {
        settings.tracking_paused_value.as_str()
    };
    let paused_until = if settings.tracking_paused_until.is_empty() {
        "0"
    } else {
        settings.tracking_paused_until.as_str()
    };
    database
        .update_lifecycle_settings(&[
            ("recording_consent", consent),
            ("launch_at_login", startup),
            ("tracking_schedule_enabled", schedule),
            ("tracking_paused", paused),
            ("tracking_paused_until", paused_until),
        ])
        .await
}

fn restore_external_tracker_state(
    settings: &LifecycleSettings,
    tracker_was_running: bool,
    system: &dyn TrackingSystem,
) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = system.set_startup(settings.launch_at_login) {
        errors.push(error);
    }
    match system.is_running() {
        Ok(running) if running == tracker_was_running => {}
        Ok(true) => {
            if let Err(error) = system.stop() {
                errors.push(error);
            }
        }
        Ok(false) => {
            if let Err(error) = system.start() {
                errors.push(error);
            }
        }
        Err(error) => errors.push(error),
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

async fn cancel_restore_after_failure(
    database: &TimeDatabase,
    previous: &LifecycleSettings,
    tracker_was_running: bool,
    system: &dyn TrackingSystem,
    original: String,
) -> Result<(), String> {
    let mut compensation_errors = Vec::new();
    if let Err(error) = database.cancel_pending_restore() {
        compensation_errors.push(error);
    }
    if let Err(error) = restore_lifecycle_settings(database, previous).await {
        compensation_errors.push(error);
    }
    if let Err(error) = restore_external_tracker_state(previous, tracker_was_running, system) {
        compensation_errors.push(error);
    }
    if compensation_errors.is_empty() {
        Err(original)
    } else {
        Err(format!(
            "{original}; restore compensation failed: {}",
            compensation_errors.join("; ")
        ))
    }
}

/// Stage and prepare a restore up to the point where the app must restart.
///
/// The restart itself belongs to `lib.rs`, but all pre-restart side effects
/// live here so tests can inject startup/process failures without invoking
/// Windows registry or process APIs. Cancellation restores the exact
/// lifecycle snapshot, including both pause values, and reconciles the
/// external startup/tracker state with what existed before staging began.
pub(crate) async fn prepare_restore_for_restart(
    database: &TimeDatabase,
    backup_path: PathBuf,
    system: &dyn TrackingSystem,
) -> Result<(), String> {
    let previous = database.lifecycle_settings().await?;
    let tracker_was_running = system.is_running()?;
    let mut pending = match database.prepare_restore(backup_path).await {
        Ok(pending) => pending,
        Err(error) => {
            let _ = database.cancel_pending_restore();
            return Err(error);
        }
    };

    if let Err(error) = database
        .update_lifecycle_settings(&[
            ("recording_consent", "0"),
            ("launch_at_login", "0"),
            ("tracking_schedule_enabled", "0"),
            ("tracking_paused", "0"),
            ("tracking_paused_until", "0"),
        ])
        .await
    {
        return cancel_restore_after_failure(
            database,
            &previous,
            tracker_was_running,
            system,
            error,
        )
        .await;
    }
    if let Err(error) = system.set_startup(false) {
        return cancel_restore_after_failure(
            database,
            &previous,
            tracker_was_running,
            system,
            error,
        )
        .await;
    }
    if let Err(error) = system.stop() {
        return cancel_restore_after_failure(
            database,
            &previous,
            tracker_was_running,
            system,
            error,
        )
        .await;
    }
    match system.is_running() {
        Ok(false) => {}
        Ok(true) => {
            return cancel_restore_after_failure(
                database,
                &previous,
                tracker_was_running,
                system,
                "The tracker is still running after stop".into(),
            )
            .await;
        }
        Err(error) => {
            return cancel_restore_after_failure(
                database,
                &previous,
                tracker_was_running,
                system,
                error,
            )
            .await;
        }
    }
    // The pending marker's rollback database is made from the live database
    // below. Restore the exact pre-restore lifecycle snapshot while the
    // tracker is already stopped, so a later swap failure can roll back to a
    // database that still has the prior consent, startup, schedule, and pause
    // state rather than the temporary fail-closed values.
    if let Err(error) = restore_lifecycle_settings(database, &previous).await {
        return cancel_restore_after_failure(
            database,
            &previous,
            tracker_was_running,
            system,
            error,
        )
        .await;
    }
    if let Err(error) = database.refresh_pending_safety_backup(&mut pending).await {
        return cancel_restore_after_failure(
            database,
            &previous,
            tracker_was_running,
            system,
            error,
        )
        .await;
    }
    Ok(())
}

pub(crate) async fn execute_tracking_lifecycle(
    database: &TimeDatabase,
    action: TrackingLifecycleAction,
    system: &dyn TrackingSystem,
) -> Result<LifecycleResult, String> {
    match action {
        TrackingLifecycleAction::CompleteOnboarding {
            enable,
            record_window_titles,
            start_at_login,
        } => {
            complete_onboarding(
                database,
                system,
                enable,
                record_window_titles,
                start_at_login,
            )
            .await
        }
        TrackingLifecycleAction::SetRecording { enabled } => {
            set_recording(database, system, enabled).await
        }
        TrackingLifecycleAction::SetStartup { enabled } => {
            set_startup(database, system, enabled).await
        }
        TrackingLifecycleAction::SetSchedule {
            enabled,
            days,
            start_minute,
            end_minute,
        } => set_schedule(database, system, enabled, days, start_minute, end_minute).await,
        TrackingLifecycleAction::Resume => {
            let settings = database.lifecycle_settings().await?;
            if !settings.recording_consent {
                return Err("Recording consent is required to resume tracking".into());
            }
            database
                .update_lifecycle_settings(&[
                    ("tracking_paused", "0"),
                    ("tracking_paused_until", "0"),
                ])
                .await?;
            let tracker_started = match ensure_recording_tracker(database, system).await {
                Ok(started) => started,
                Err(error) => {
                    // Put the pause back rather than fail closed. Consent was
                    // already given and is not in question; what failed is the
                    // launch. Leaving the pause cleared would report the state
                    // as a dead tracker when nothing about the machine changed,
                    // and the reader's own pause is the more truthful answer.
                    compensate_to_previous(database, system, &settings).await;
                    return Err(error);
                }
            };
            current_result(database, tracker_started, 0).await
        }
        TrackingLifecycleAction::EnsureStarted => {
            let settings = database.lifecycle_settings().await?;
            if !settings.recording_consent {
                return Err("Recording consent is required to start tracking".into());
            }
            // Nothing to compensate. This action changes no stored state, and a
            // launch that failed has recorded nothing, so the fail-closed
            // outcome is already the actual one. Revoking consent here turned a
            // retryable error into a configuration the reader had to rebuild --
            // and this is the action the "Time has stopped recording" banner
            // calls, so the failure and the punishment arrived together.
            let tracker_started = ensure_recording_tracker(database, system).await?;
            current_result(database, tracker_started, 0).await
        }
        TrackingLifecycleAction::RestoreDefaults => {
            // The database is changed first so an interrupted operation is
            // fail-closed even if Windows startup cleanup takes a moment.
            database.restore_default_settings().await?;
            stop_and_unregister(database, system).await?;
            current_result(database, false, 0).await
        }
        TrackingLifecycleAction::SecureErase => {
            database
                .update_lifecycle_settings(&[
                    ("recording_consent", "0"),
                    ("launch_at_login", "0"),
                    ("tracking_schedule_enabled", "0"),
                    ("tracking_paused", "0"),
                    ("tracking_paused_until", "0"),
                ])
                .await?;
            stop_and_unregister(database, system).await?;
            let deleted_count = database.erase_history().await?;
            current_result(database, false, deleted_count).await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use super::*;

    #[derive(Default)]
    struct FakeSystem {
        calls: Arc<StdMutex<Vec<String>>>,
        fail_start: bool,
        fail_stop: bool,
        fail_startup: bool,
        fail_is_running: bool,
        fail_is_running_after_first: bool,
        fail_startup_query: bool,
        running: bool,
        is_running_calls: Arc<StdMutex<u32>>,
        running_state: Option<Arc<StdMutex<bool>>>,
        startup_state: Option<Arc<StdMutex<bool>>>,
    }

    impl TrackingSystem for FakeSystem {
        fn start(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("start".into());
            if self.fail_start {
                Err("start failed".into())
            } else {
                if let Some(state) = &self.running_state {
                    *state.lock().unwrap() = true;
                }
                Ok(())
            }
        }

        fn stop(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("stop".into());
            if self.fail_stop {
                Err("stop failed".into())
            } else {
                if let Some(state) = &self.running_state {
                    *state.lock().unwrap() = false;
                }
                Ok(())
            }
        }

        fn set_startup(&self, enabled: bool) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("startup:{enabled}"));
            if self.fail_startup {
                Err("startup failed".into())
            } else {
                if let Some(state) = &self.startup_state {
                    *state.lock().unwrap() = enabled;
                }
                Ok(())
            }
        }

        fn startup_is_registered(&self) -> Result<bool, String> {
            self.calls.lock().unwrap().push("startup?".into());
            if self.fail_startup_query {
                return Err("startup query failed".into());
            }
            // Unregistered unless a test opts into tracking the state, which
            // is what a machine that has never registered startup looks like.
            Ok(self
                .startup_state
                .as_ref()
                .is_some_and(|state| *state.lock().unwrap()))
        }

        fn is_running(&self) -> Result<bool, String> {
            let mut calls = self.is_running_calls.lock().unwrap();
            *calls += 1;
            if self.fail_is_running || (self.fail_is_running_after_first && *calls > 1) {
                return Err("status query failed".into());
            }
            Ok(self
                .running_state
                .as_ref()
                .map(|state| *state.lock().unwrap())
                .unwrap_or(self.running))
        }
    }

    fn unix_now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    /// Write the tracker's own health stamp, which is the only thing that
    /// distinguishes a working tracker from a process with the same name.
    /// Lifecycle writes skip the renderer allowlist, which is what lets a test
    /// stand in for the tracker here.
    async fn stamp_health(database: &TimeDatabase, stamp: i64) {
        let value = stamp.to_string();
        database
            .update_lifecycle_settings(&[("tracker_health_heartbeat", &value)])
            .await
            .unwrap();
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("time-lifecycle-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root.join("database.db")
    }

    async fn lifecycle_values(path: PathBuf) -> (String, String, String, String, String) {
        let database = TimeDatabase::open(path).await.unwrap();
        let values = (
            sqlx::query_scalar("SELECT value FROM settings WHERE key='recording_consent'")
                .fetch_one(database.test_pool())
                .await
                .unwrap(),
            sqlx::query_scalar("SELECT value FROM settings WHERE key='launch_at_login'")
                .fetch_one(database.test_pool())
                .await
                .unwrap(),
            sqlx::query_scalar("SELECT value FROM settings WHERE key='tracking_schedule_enabled'")
                .fetch_one(database.test_pool())
                .await
                .unwrap(),
            sqlx::query_scalar("SELECT value FROM settings WHERE key='tracking_paused'")
                .fetch_one(database.test_pool())
                .await
                .unwrap(),
            sqlx::query_scalar("SELECT value FROM settings WHERE key='tracking_paused_until'")
                .fetch_one(database.test_pool())
                .await
                .unwrap(),
        );
        database.close().await;
        values
    }

    #[test]
    fn recording_requires_consent_for_startup_and_schedule() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("requires-consent"))
                .await
                .unwrap();
            let system = FakeSystem::default();
            assert!(execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetStartup { enabled: true },
                &system,
            )
            .await
            .is_err());
            assert!(execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetSchedule {
                    enabled: true,
                    days: Some("0,1,2,3,4".into()),
                    start_minute: Some(540),
                    end_minute: Some(1020),
                },
                &system,
            )
            .await
            .is_err());
            database.close().await;
        });
    }

    #[test]
    fn schedule_rejects_empty_days_and_each_invalid_minute() {
        assert!(validate_schedule(Some(""), None, None).is_err());
        assert!(validate_schedule(Some("0,,1"), None, None).is_err());
        assert!(validate_schedule(None, Some(24 * 60), None).is_err());
        assert!(validate_schedule(None, None, Some(24 * 60)).is_err());
        assert!(validate_schedule(None, Some(60), Some(60)).is_err());
        assert!(validate_schedule(Some("0,1"), Some(60), None).is_ok());
    }

    #[test]
    fn enabled_schedule_rejects_missing_fields_instead_of_using_database_values() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("schedule-missing-fields"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1")])
                .await
                .unwrap();
            let error = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetSchedule {
                    enabled: true,
                    days: None,
                    start_minute: None,
                    end_minute: None,
                },
                &FakeSystem::default(),
            )
            .await
            .unwrap_err();
            assert!(error.contains("require days"));
            database.close().await;
        });
    }

    #[test]
    fn disabled_schedule_updates_complete_window_without_enabling_recording() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("schedule-window-while-off"))
                .await
                .unwrap();
            let result = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetSchedule {
                    enabled: false,
                    days: Some("5,6".into()),
                    start_minute: Some(1),
                    end_minute: Some(2),
                },
                &FakeSystem::default(),
            )
            .await
            .unwrap();
            assert!(!result.schedule_enabled);
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(!settings.schedule_enabled);
            let days: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='tracking_schedule_days'")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
            assert_eq!(days, "5,6");
            database.close().await;
        });
    }

    #[test]
    fn start_failure_compensates_to_disabled_state() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("start-failure")).await.unwrap();
            let system = FakeSystem {
                fail_start: true,
                ..FakeSystem::default()
            };
            assert!(execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetRecording { enabled: true },
                &system,
            )
            .await
            .is_err());
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(!settings.recording_consent);
            assert!(!settings.launch_at_login);
            assert!(!settings.schedule_enabled);
            assert!(system
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call == "startup:false"));
            assert!(system
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call == "stop"));
            database.close().await;
        });
    }

    /// A launch that failed is not a reason to retire the reader's settings.
    ///
    /// Both of these actions run on a database that has already consented, so
    /// there is nothing to fail closed *to*: no tracker started, which means
    /// nothing is being recorded either way. Revoking consent, startup and the
    /// schedule turned one retryable error into a configuration the reader had
    /// to rebuild — and `EnsureStarted` is what the "Time has stopped
    /// recording" banner calls, so the failure and the punishment arrived in
    /// the same click.
    #[test]
    fn resume_and_ensure_failures_keep_the_configuration_they_found() {
        tauri::async_runtime::block_on(async {
            // Both actions, against both ways the launch can fail. The status
            // query is worth its own case because it shells out to `tasklist`,
            // so it fails for reasons that say nothing about the tracker.
            for action in [
                TrackingLifecycleAction::Resume,
                TrackingLifecycleAction::EnsureStarted,
            ] {
                for failing_status in [false, true] {
                    let name = &format!(
                        "{}-{}-failure",
                        if matches!(action, TrackingLifecycleAction::Resume) {
                            "resume"
                        } else {
                            "ensure"
                        },
                        if failing_status { "status" } else { "start" }
                    );
                    let action = action.clone();
                    let database = TimeDatabase::open(scratch(name)).await.unwrap();
                    database
                        .update_lifecycle_settings(&[
                            ("recording_consent", "1"),
                            ("launch_at_login", "1"),
                            ("tracking_schedule_enabled", "1"),
                            ("tracking_paused", "1"),
                        ])
                        .await
                        .unwrap();
                    let system = FakeSystem {
                        fail_start: !failing_status,
                        fail_is_running: failing_status,
                        ..FakeSystem::default()
                    };
                    assert!(
                        execute_tracking_lifecycle(&database, action, &system)
                            .await
                            .is_err(),
                        "{name} should report the launch failure"
                    );
                    let settings = database.lifecycle_settings().await.unwrap();
                    assert!(settings.recording_consent, "{name} kept consent");
                    assert!(settings.launch_at_login, "{name} kept startup");
                    assert!(settings.schedule_enabled, "{name} kept the schedule");
                    // Resume clears the pause before launching, so the failure
                    // has to put it back: the reader's own pause describes a
                    // machine nothing changed on better than a dead tracker.
                    assert!(settings.tracking_paused, "{name} kept the pause");
                    let calls = system.calls.lock().unwrap().clone();
                    assert!(
                        !calls.iter().any(|call| call == "startup:false"),
                        "{name} must not unregister a startup it did not register: {calls:?}"
                    );
                    assert!(
                        !calls.iter().any(|call| call == "stop"),
                        "{name} must not stop a tracker whose consent survived: {calls:?}"
                    );
                    database.close().await;
                }
            }
        });
    }

    /// The defect the "Time has stopped recording" banner was built to fix, and
    /// then could not.
    ///
    /// tracker.py wraps its whole tick in one `except Exception` with the health
    /// stamp inside it, so a persistent failure leaves a process that is listed,
    /// silent, and recording nothing. The banner reads staleness and fires; the
    /// button used to read the process list and return.
    #[test]
    fn starting_replaces_a_tracker_that_is_listed_but_no_longer_answering() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("ensure-wedged")).await.unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1")])
                .await
                .unwrap();
            stamp_health(&database, unix_now() - TRACKER_UNRESPONSIVE_SECONDS - 1).await;
            let system = FakeSystem {
                running_state: Some(Arc::new(StdMutex::new(true))),
                ..FakeSystem::default()
            };
            let result = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::EnsureStarted,
                &system,
            )
            .await
            .unwrap();
            assert!(result.tracker_started);
            let calls = system.calls.lock().unwrap().clone();
            let stop = calls.iter().position(|call| call == "stop");
            let start = calls.iter().position(|call| call == "start");
            assert!(stop.is_some() && start.is_some(), "calls: {calls:?}");
            assert!(stop < start, "the wedged process must go first: {calls:?}");
            database.close().await;
        });
    }

    /// The other half of the contract: a tracker that is answering is left
    /// alone. Without this, every press of the button — and every "turn on
    /// recording" — would cost a healthy tracker its open session.
    #[test]
    fn starting_leaves_a_tracker_that_is_still_answering_untouched() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("ensure-healthy")).await.unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1")])
                .await
                .unwrap();
            stamp_health(&database, unix_now()).await;
            let system = FakeSystem {
                running_state: Some(Arc::new(StdMutex::new(true))),
                ..FakeSystem::default()
            };
            let result = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::EnsureStarted,
                &system,
            )
            .await
            .unwrap();
            assert!(!result.tracker_started);
            let calls = system.calls.lock().unwrap().clone();
            assert!(
                !calls.iter().any(|call| call == "stop" || call == "start"),
                "calls: {calls:?}"
            );
            database.close().await;
        });
    }

    /// Enabling recording is an enable, so its compensation is the state it
    /// found — not zero. A schedule the reader had configured must survive a
    /// tracker that would not launch.
    #[test]
    fn a_failed_enable_restores_the_schedule_it_found() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("enable-failure")).await.unwrap();
            database
                .update_lifecycle_settings(&[
                    ("recording_consent", "0"),
                    ("launch_at_login", "1"),
                    ("tracking_schedule_enabled", "1"),
                ])
                .await
                .unwrap();
            let system = FakeSystem {
                fail_start: true,
                ..FakeSystem::default()
            };
            assert!(execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetRecording { enabled: true },
                &system,
            )
            .await
            .is_err());
            let settings = database.lifecycle_settings().await.unwrap();
            // Consent goes back off: that is what this call was trying to
            // change and it did not succeed.
            assert!(!settings.recording_consent);
            // These it never asked about.
            assert!(settings.launch_at_login);
            assert!(settings.schedule_enabled);
            database.close().await;
        });
    }

    #[test]
    fn startup_and_schedule_keep_consent_scoped_and_schedule_forces_startup() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("schedule-forces-startup"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1")])
                .await
                .unwrap();
            let system = FakeSystem::default();
            let result = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetSchedule {
                    enabled: true,
                    days: Some("1,2,3".into()),
                    start_minute: Some(540),
                    end_minute: Some(1020),
                },
                &system,
            )
            .await
            .unwrap();
            assert!(result.recording_consent);
            assert!(result.launch_at_login);
            assert!(result.schedule_enabled);
            assert!(system
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call == "startup:true"));

            let error = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetStartup { enabled: false },
                &system,
            )
            .await
            .unwrap_err();
            assert!(error.contains("scheduling"));
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(settings.recording_consent);
            assert!(settings.launch_at_login);
            assert!(settings.schedule_enabled);
            database.close().await;
        });
    }

    #[test]
    fn schedule_registration_failure_reverts_only_startup_side_effect() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("schedule-registration-failure"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1")])
                .await
                .unwrap();
            let system = FakeSystem {
                fail_startup: true,
                ..FakeSystem::default()
            };
            assert!(execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetSchedule {
                    enabled: true,
                    days: Some("0,1,2,3,4".into()),
                    start_minute: Some(540),
                    end_minute: Some(1020),
                },
                &system,
            )
            .await
            .is_err());
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(settings.recording_consent);
            assert!(!settings.launch_at_login);
            assert!(!settings.schedule_enabled);
            let calls = system.calls.lock().unwrap();
            assert!(calls.iter().any(|call| call == "startup:true"));
            assert!(calls.iter().any(|call| call == "startup:false"));
            assert!(!calls.iter().any(|call| call == "stop"));
            database.close().await;
        });
    }

    #[test]
    fn startup_registration_failure_preserves_existing_consent() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("startup-registration-failure"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1")])
                .await
                .unwrap();
            let system = FakeSystem {
                fail_startup: true,
                ..FakeSystem::default()
            };
            assert!(execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetStartup { enabled: true },
                &system,
            )
            .await
            .is_err());
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(settings.recording_consent);
            assert!(!settings.launch_at_login);
            assert!(!settings.schedule_enabled);
            let calls = system.calls.lock().unwrap();
            assert!(calls.iter().any(|call| call == "startup:true"));
            assert!(calls.iter().any(|call| call == "startup:false"));
            assert!(!calls.iter().any(|call| call == "stop"));
            database.close().await;
        });
    }

    #[test]
    fn enabling_startup_rewrites_a_registration_windows_no_longer_has() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("startup-reassert"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1"), ("launch_at_login", "1")])
                .await
                .unwrap();
            let system = FakeSystem::default();
            let result = execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::SetStartup { enabled: true },
                &system,
            )
            .await
            .unwrap();
            assert!(result.launch_at_login);
            // A database that already says on is exactly the state a lost Run
            // value leaves behind, and the state somebody is in when they reach
            // for this switch. Reporting success without writing the
            // registration is what made that state unrepairable from the UI.
            let calls = system.calls.lock().unwrap();
            assert!(calls.iter().any(|call| call == "startup:true"));
            drop(calls);
            database.close().await;
        });
    }

    #[test]
    fn reconciliation_restores_a_registration_removed_outside_the_application() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("reconcile-restores"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1"), ("launch_at_login", "1")])
                .await
                .unwrap();
            let startup_state = Arc::new(StdMutex::new(false));
            let system = FakeSystem {
                startup_state: Some(startup_state.clone()),
                ..FakeSystem::default()
            };
            assert!(reconcile_startup_registration(&database, &system)
                .await
                .unwrap());
            assert!(*startup_state.lock().unwrap());
            // The launch after the repair has nothing to do. A reconciler that
            // rewrites regardless cannot tell a healthy install from a broken
            // one, which is how a repair turns into a thing that hides the
            // problem it was added to find.
            assert!(!reconcile_startup_registration(&database, &system)
                .await
                .unwrap());
            let calls = system.calls.lock().unwrap();
            assert_eq!(
                calls.iter().filter(|call| *call == "startup:true").count(),
                1
            );
            drop(calls);
            database.close().await;
        });
    }

    #[test]
    fn reconciliation_removes_a_registration_the_database_does_not_authorize() {
        tauri::async_runtime::block_on(async {
            // Withdrawn consent counts the same as startup switched off, for the
            // reason restore applies the same pair: registration is authorized
            // by consent, never by the startup flag on its own.
            let cases = [
                (
                    "reconcile-without-consent",
                    [("recording_consent", "0"), ("launch_at_login", "1")],
                ),
                (
                    "reconcile-startup-off",
                    [("recording_consent", "1"), ("launch_at_login", "0")],
                ),
            ];
            for (name, settings) in cases {
                let database = TimeDatabase::open(scratch(name)).await.unwrap();
                database.update_lifecycle_settings(&settings).await.unwrap();
                let startup_state = Arc::new(StdMutex::new(true));
                let system = FakeSystem {
                    startup_state: Some(startup_state.clone()),
                    ..FakeSystem::default()
                };
                assert!(reconcile_startup_registration(&database, &system)
                    .await
                    .unwrap());
                assert!(!*startup_state.lock().unwrap());
                database.close().await;
            }
        });
    }

    #[test]
    fn reconciliation_that_cannot_read_windows_writes_nothing() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("reconcile-query-failure"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[("recording_consent", "1"), ("launch_at_login", "1")])
                .await
                .unwrap();
            let system = FakeSystem {
                fail_startup_query: true,
                ..FakeSystem::default()
            };
            // Guessing here would mean writing a registration on every launch
            // that could not read one back, which is the same silent write loop
            // whether the value is already correct or the registry is unusable.
            assert!(reconcile_startup_registration(&database, &system)
                .await
                .is_err());
            let calls = system.calls.lock().unwrap();
            assert!(!calls.iter().any(|call| call.starts_with("startup:")));
            drop(calls);
            database.close().await;
        });
    }

    /// Onboarding is the one enable whose compensation is genuinely "all off".
    ///
    /// It runs once, on a database that has never consented, so the fail-closed
    /// state it forces is the state that was already there. The same
    /// compensation applied to `SetRecording` or `Resume` retired settings the
    /// reader had configured; those two are covered by
    /// `resume_and_ensure_failures_keep_the_configuration_they_found` and
    /// `a_failed_enable_restores_the_schedule_it_found` instead.
    #[test]
    fn status_query_failure_during_onboarding_compensates() {
        tauri::async_runtime::block_on(async {
            let cases = [(
                "onboarding-status-failure",
                TrackingLifecycleAction::CompleteOnboarding {
                    enable: true,
                    record_window_titles: false,
                    start_at_login: false,
                },
            )];
            for (name, action) in cases {
                let database = TimeDatabase::open(scratch(name)).await.unwrap();
                database
                    .update_lifecycle_settings(&[
                        ("recording_consent", "1"),
                        ("launch_at_login", "1"),
                        ("tracking_schedule_enabled", "1"),
                        ("tracking_paused", "1"),
                        ("tracking_paused_until", "123"),
                    ])
                    .await
                    .unwrap();
                let system = FakeSystem {
                    fail_is_running: true,
                    ..FakeSystem::default()
                };
                assert!(
                    execute_tracking_lifecycle(&database, action.clone(), &system)
                        .await
                        .is_err()
                );
                let settings = database.lifecycle_settings().await.unwrap();
                assert!(!settings.recording_consent);
                assert!(!settings.launch_at_login);
                assert!(!settings.schedule_enabled);
                let paused: String =
                    sqlx::query_scalar("SELECT value FROM settings WHERE key='tracking_paused'")
                        .fetch_one(database.test_pool())
                        .await
                        .unwrap();
                assert_eq!(paused, "0");
                if matches!(action, TrackingLifecycleAction::CompleteOnboarding { .. }) {
                    let onboarding: String = sqlx::query_scalar(
                        "SELECT value FROM settings WHERE key='privacy_onboarding_complete'",
                    )
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
                    assert_eq!(onboarding, "0");
                }
                assert!(system
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|call| call == "stop"));
                database.close().await;
            }
        });
    }

    #[test]
    fn secure_erase_never_deletes_until_tracker_is_stopped() {
        tauri::async_runtime::block_on(async {
            for (name, system) in [
                (
                    "erase-stop-failure",
                    FakeSystem {
                        fail_stop: true,
                        ..FakeSystem::default()
                    },
                ),
                (
                    "erase-still-running",
                    FakeSystem {
                        running: true,
                        ..FakeSystem::default()
                    },
                ),
            ] {
                let database = TimeDatabase::open(scratch(name)).await.unwrap();
                database
                    .update_lifecycle_settings(&[
                        ("recording_consent", "1"),
                        ("launch_at_login", "1"),
                        ("tracking_schedule_enabled", "1"),
                    ])
                    .await
                    .unwrap();
                sqlx::query(
                    "INSERT INTO sessions (start_ts,end_ts,process) VALUES (10,20,'x.exe')",
                )
                .execute(database.test_pool())
                .await
                .unwrap();
                assert!(execute_tracking_lifecycle(
                    &database,
                    TrackingLifecycleAction::SecureErase,
                    &system,
                )
                .await
                .is_err());
                let settings = database.lifecycle_settings().await.unwrap();
                assert!(!settings.recording_consent);
                assert!(!settings.launch_at_login);
                assert!(!settings.schedule_enabled);
                let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
                assert_eq!(sessions, 1);
                database.close().await;
            }
        });
    }

    #[test]
    fn coordinator_serializes_two_contenders() {
        tauri::async_runtime::block_on(async {
            let coordinator = LifecycleCoordinator::default();
            let first = coordinator.gate().lock().await;
            // The second contender cannot enter while the first operation is
            // in progress; the same gate is used by every native command.
            assert!(coordinator.gate().try_lock().is_err());
            drop(first);
            assert!(coordinator.gate().try_lock().is_ok());
        });
    }

    #[test]
    fn successful_prepare_keeps_exact_lifecycle_state_in_safety_and_rollback_copies() {
        tauri::async_runtime::block_on(async {
            let path = scratch("restore-success-state-copies");
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            database
                .update_lifecycle_settings(&[
                    ("recording_consent", "1"),
                    ("launch_at_login", "1"),
                    ("tracking_schedule_enabled", "1"),
                    ("tracking_paused", "paused-token"),
                    ("tracking_paused_until", "until-token"),
                ])
                .await
                .unwrap();
            let expected = (
                "1".to_owned(),
                "1".to_owned(),
                "1".to_owned(),
                "paused-token".to_owned(),
                "until-token".to_owned(),
            );
            let backup = database
                .backup_with_name("restore-success-source")
                .await
                .unwrap();
            let running_state = Arc::new(StdMutex::new(true));
            let system = FakeSystem {
                running: true,
                running_state: Some(running_state),
                ..FakeSystem::default()
            };
            prepare_restore_for_restart(&database, PathBuf::from(backup), &system)
                .await
                .unwrap();

            let marker_path = path.with_file_name("restore_pending.json");
            let marker: crate::database::PendingRestore =
                serde_json::from_slice(&std::fs::read(&marker_path).unwrap()).unwrap();
            let safety_values = lifecycle_values(PathBuf::from(marker.safety_backup_path)).await;
            assert_eq!(safety_values, expected);

            // Complete only the file swap that the next process would perform,
            // then inspect the old live file in the rollback slot.
            database.close().await;
            let swap = TimeDatabase::begin_pending_restore(&path)
                .await
                .unwrap()
                .unwrap();
            let rollback_values =
                lifecycle_values(path.with_file_name("restore_previous.db")).await;
            assert_eq!(rollback_values, expected);
            swap.rollback().unwrap();
        });
    }

    #[test]
    fn restore_stop_failure_restores_exact_pause_state_and_external_state() {
        tauri::async_runtime::block_on(async {
            let path = scratch("restore-stop-failure");
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            database
                .update_lifecycle_settings(&[
                    ("recording_consent", "1"),
                    ("launch_at_login", "1"),
                    ("tracking_schedule_enabled", "1"),
                    ("tracking_paused", "1"),
                    ("tracking_paused_until", "987654"),
                ])
                .await
                .unwrap();
            let backup = database
                .backup_with_name("restore-stop-source")
                .await
                .unwrap();
            let system = FakeSystem {
                fail_stop: true,
                running: true,
                ..FakeSystem::default()
            };
            let error = prepare_restore_for_restart(&database, PathBuf::from(backup), &system)
                .await
                .unwrap_err();
            assert!(error.contains("stop failed"));
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(settings.recording_consent);
            assert!(settings.launch_at_login);
            assert!(settings.schedule_enabled);
            assert!(settings.tracking_paused);
            assert_eq!(settings.tracking_paused_value, "1");
            assert_eq!(settings.tracking_paused_until, "987654");
            assert!(path.with_file_name("restore_pending.json").exists() == false);
            let calls = system.calls.lock().unwrap();
            assert!(calls.iter().any(|call| call == "startup:false"));
            assert!(calls.iter().any(|call| call == "startup:true"));
            database.close().await;
        });
    }

    #[test]
    fn restore_status_failure_after_stop_restores_exact_pause_state() {
        tauri::async_runtime::block_on(async {
            let path = scratch("restore-status-failure");
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            database
                .update_lifecycle_settings(&[
                    ("recording_consent", "1"),
                    ("launch_at_login", "1"),
                    ("tracking_schedule_enabled", "1"),
                    ("tracking_paused", "1"),
                    ("tracking_paused_until", "654321"),
                ])
                .await
                .unwrap();
            let backup = database
                .backup_with_name("restore-status-source")
                .await
                .unwrap();
            let system = FakeSystem {
                fail_is_running_after_first: true,
                running: true,
                ..FakeSystem::default()
            };
            let error = prepare_restore_for_restart(&database, PathBuf::from(backup), &system)
                .await
                .unwrap_err();
            assert!(error.contains("status query failed"));
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(settings.recording_consent);
            assert!(settings.launch_at_login);
            assert!(settings.schedule_enabled);
            assert!(settings.tracking_paused);
            assert_eq!(settings.tracking_paused_until, "654321");
            assert!(!path.with_file_name("restore_pending.json").exists());
            database.close().await;
        });
    }

    #[test]
    fn restore_startup_failure_cancels_pending_and_restores_lifecycle_state() {
        tauri::async_runtime::block_on(async {
            let path = scratch("restore-startup-failure");
            let database = TimeDatabase::open(path.clone()).await.unwrap();
            database
                .update_lifecycle_settings(&[
                    ("recording_consent", "1"),
                    ("launch_at_login", "0"),
                    ("tracking_schedule_enabled", "0"),
                    ("tracking_paused", "1"),
                    ("tracking_paused_until", "123"),
                ])
                .await
                .unwrap();
            let backup = database
                .backup_with_name("restore-startup-source")
                .await
                .unwrap();
            let system = FakeSystem {
                fail_startup: true,
                running: false,
                ..FakeSystem::default()
            };
            let error = prepare_restore_for_restart(&database, PathBuf::from(backup), &system)
                .await
                .unwrap_err();
            assert!(error.contains("startup failed"));
            let settings = database.lifecycle_settings().await.unwrap();
            assert!(settings.recording_consent);
            assert!(!settings.launch_at_login);
            assert!(!settings.schedule_enabled);
            assert!(settings.tracking_paused);
            assert_eq!(settings.tracking_paused_until, "123");
            assert!(!path.with_file_name("restore_pending.json").exists());
            database.close().await;
        });
    }

    #[test]
    fn restore_defaults_resets_theme_and_preserves_data() {
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(scratch("restore-defaults"))
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[
                    ("theme", "dark"),
                    ("recording_consent", "1"),
                    ("launch_at_login", "1"),
                    ("tracking_schedule_enabled", "1"),
                ])
                .await
                .unwrap();
            database
                .update_lifecycle_settings(&[
                    ("process_aliases", "{\"editor.exe\":\"Editor\"}"),
                    ("privacy_onboarding_complete", "1"),
                    ("welcome_dismissed", "7"),
                    ("recording_off_notice_dismissed", "8"),
                ])
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO categories (name,color,is_productive,is_neutral,is_ignored,sort_order) \
                 VALUES ('Custom','#123456',1,0,0,6)",
            )
            .execute(database.test_pool())
            .await
            .unwrap();
            let category_id: i64 =
                sqlx::query_scalar("SELECT id FROM categories WHERE name='Custom'")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
            sqlx::query(
                "INSERT INTO rules (match_type,pattern,category_id) VALUES ('process','custom.exe',?)",
            )
            .bind(category_id)
            .execute(database.test_pool())
            .await
            .unwrap();
            sqlx::query("INSERT INTO sessions (start_ts,end_ts,process) VALUES (1,2,'x.exe')")
                .execute(database.test_pool())
                .await
                .unwrap();
            sqlx::query("INSERT INTO tracking_exclusions (kind,pattern,created_ts) VALUES ('website','example.com',1)")
                .execute(database.test_pool())
                .await
                .unwrap();
            let backup_path = database.backups_dir().unwrap().join("kept.db");
            std::fs::write(&backup_path, b"backup").unwrap();
            let system = FakeSystem::default();
            execute_tracking_lifecycle(
                &database,
                TrackingLifecycleAction::RestoreDefaults,
                &system,
            )
            .await
            .unwrap();
            let theme: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='theme'")
                .fetch_one(database.test_pool())
                .await
                .unwrap();
            let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
                .fetch_one(database.test_pool())
                .await
                .unwrap();
            let exclusions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tracking_exclusions")
                .fetch_one(database.test_pool())
                .await
                .unwrap();
            let categories: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM categories WHERE name='Custom'")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
            let rules: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM rules WHERE pattern='custom.exe'")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
            let process_aliases: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='process_aliases'")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
            let onboarding: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key='privacy_onboarding_complete'",
            )
            .fetch_one(database.test_pool())
            .await
            .unwrap();
            let notice: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key='welcome_dismissed'")
                    .fetch_one(database.test_pool())
                    .await
                    .unwrap();
            assert_eq!(theme, "system");
            let lifecycle = database.lifecycle_settings().await.unwrap();
            assert!(!lifecycle.recording_consent);
            assert!(!lifecycle.launch_at_login);
            assert!(!lifecycle.schedule_enabled);
            assert_eq!(sessions, 1);
            assert_eq!(exclusions, 1);
            assert_eq!(categories, 1);
            assert_eq!(rules, 1);
            assert_eq!(process_aliases, "{\"editor.exe\":\"Editor\"}");
            assert_eq!(onboarding, "1");
            assert_eq!(notice, "7");
            assert!(backup_path.is_file());
            database.close().await;
        });
    }
}
