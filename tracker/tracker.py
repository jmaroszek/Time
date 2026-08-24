"""Always-on tracker entry point.

Run with:  pythonw tracker/tracker.py   (or python, for a console)

Responsibilities: single-instance guard, logging, supervised 1s loop, settings
refresh, graceful shutdown. All session logic lives in session_manager.
"""

from __future__ import annotations

import atexit
import ctypes
import logging
import os
import platform
import sys
import threading
import time
import traceback
from dataclasses import replace
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker import config, db, media_playback, power_events, tray, win32_probe
from tracker.domains import parse_domain
from tracker.session_manager import LOCK_PROCESS, SessionManager, is_idle
from tracker.tracking_schedule import schedule_state

_ERROR_ALREADY_EXISTS = 183
_mutex_handle = None  # keep a module-level reference so the handle lives forever

# Seven daily files: long enough to cover "it broke sometime last week", short
# enough that the log directory stays a bounded, disposable support artifact.
LOG_RETENTION_DAYS = 7
# A fault in the 1 Hz loop repeats 86,400 times a day. Collapse identical
# repeats to one line per interval so a single bad day cannot grow without limit.
FAILURE_SUMMARY_SECONDS = 60.0
# Tracker health is deliberately independent of session flushing. Exclusions,
# privacy choices, or an idle database must never make a healthy process look
# absent in Settings.
HEALTH_HEARTBEAT_SECONDS = 5.0
HEALTH_HEARTBEAT_KEY = "tracker_health_heartbeat"
# Whether a tray icon is genuinely up, as opposed to whether one was asked for.
# Read by the dashboard; see _publish_tray_state.
TRAY_ACTIVE_KEY = "tracker_tray_active"
# Sixty missed polls is not a slow tick; the loop was not running. The
# suspend/resume callbacks are the fast, well-dated path for detecting sleep,
# but they can go missing — registration failure, hibernation, a notification
# lost as the machine freezes — and an interval no one watched must stay a gap
# rather than become an AFK block the user never sat through.
UNOBSERVED_GAP_SECONDS = 60.0


def acquire_single_instance() -> bool:
    global _mutex_handle
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Global\ so a second logon session (RDP, fast user switching) of the same
    # user cannot run a second tracker against the same database.
    _mutex_handle = kernel32.CreateMutexW(None, False, config.MUTEX_NAME)
    if not _mutex_handle:
        return True  # cannot check; do not block tracking over it
    return ctypes.get_last_error() != _ERROR_ALREADY_EXISTS


def set_up_logging() -> None:
    """Daily-rotating tracker log, seven days retained.

    INFO is the support level and must contain no window title and no browser
    domain: these files sit beside the database in plain text and may be handed
    to someone else. Anything derived from captured window content belongs at
    DEBUG, which is off by default.
    """
    config.LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handler = TimedRotatingFileHandler(
        filename=config.LOG_PATH,
        when="midnight",
        backupCount=LOG_RETENTION_DAYS,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.addHandler(handler)


def log_startup_environment() -> None:
    """Title-free facts that make a field report actionable without the database.

    A support log that omits these turns every report into a round trip: which
    build, source or installed, and on what Windows.
    """
    logging.info(
        "Tracker %s starting | packaged=%s | python=%s | os=%s %s (%s) | data_dir=%s",
        config.TRACKER_VERSION,
        bool(getattr(sys, "frozen", False)),
        platform.python_version(),
        platform.system(),
        platform.release(),
        platform.version(),
        config.DATA_DIR,
    )


def log_database_state(raw_settings: dict[str, str]) -> None:
    """Schema and privacy-gate milestones — booleans and versions only.

    Deliberately not the raw settings map: it carries the user's configuration,
    and the log is a support artifact, not a state dump.
    """
    logging.info(
        "Database ready | schema=%s (tracker supports %s) | consent=%s |"
        " titles=%s | onboarding_complete=%s | paused=%s",
        raw_settings.get("schema_version", "unknown"),
        db.SCHEMA_VERSION,
        raw_settings.get("recording_consent") == "1",
        raw_settings.get("record_window_titles") == "1",
        raw_settings.get("privacy_onboarding_complete") == "1",
        db.is_paused(raw_settings),
    )


def stamp_tracker_health(conn, now: float) -> None:
    """Publish process health without exposing or depending on recorded activity."""
    db.set_setting(conn, HEALTH_HEARTBEAT_KEY, str(int(now)))


def _publish_tray_state(conn, active: bool, published: bool | None) -> bool | None:
    """Record whether a tray icon is actually up, for the dashboard to read.

    `show_tray_icon` is what the reader asked for; this is what happened. The
    two diverge when the icon cannot be created at all — a bundle without
    pystray or Pillow, a shell that refuses the icon — and the switch alone
    would go on reporting a tray that is not there. That matters more than it
    sounds: the tray is the only place to pause recording without opening the
    dashboard, so its silent absence removes a control rather than a decoration.

    Written only on change. This runs on every settings poll, and a settings
    write per second would be a real cost for a value that moves approximately
    never.
    """
    if published is active:
        return published
    try:
        db.set_setting(conn, TRAY_ACTIVE_KEY, "1" if active else "0")
    except Exception:
        # Best effort, and deliberately unchanged on failure so the next poll
        # tries again. This is a report about a convenience; failing to write it
        # must not disturb recording.
        return published
    return active


def _sync_tray(
    controller: tray.TrayController | None,
    raw_settings: dict[str, str],
    now: float | None = None,
) -> bool:
    """Apply presentation settings without coupling them to session behavior."""
    if controller is None:
        return False
    visible = controller.set_enabled(db.tray_icon_enabled(raw_settings))
    controller.sync_state(
        db.is_paused(raw_settings, now),
        db.pause_until(raw_settings),
        schedule_state(raw_settings, now),
    )
    return visible


class FailureThrottle:
    """Bounds the daily log when the same failure repeats every tick.

    The first failure of a given exception type is logged with its full
    traceback — that is the evidence support needs. Identical repeats are
    counted and reported once per interval instead of once per second.
    """

    def __init__(self, summary_seconds: float = FAILURE_SUMMARY_SECONDS):
        self._summary_seconds = summary_seconds
        self._suppressed: dict[str, int] = {}
        self._last_report: dict[str, float] = {}

    def record(self, message: str, exc: BaseException, now: float) -> None:
        kind = type(exc).__name__
        last = self._last_report.get(kind)
        if last is None:
            self._last_report[kind] = now
            # exc_info takes the exception rather than logging.exception's
            # ambient sys.exc_info(), so the traceback survives a caller that
            # records outside the handler that caught it.
            logging.error("%s (%s)", message, kind, exc_info=exc)
            return
        self._suppressed[kind] = self._suppressed.get(kind, 0) + 1
        if now - last >= self._summary_seconds:
            logging.error(
                "%s: %s further %s failures in the last %.0fs",
                message,
                self._suppressed[kind],
                kind,
                now - last,
            )
            self._suppressed[kind] = 0
            self._last_report[kind] = now


class LoopContinuity:
    """Reports intervals the poll loop did not run through.

    Asks the wall clock rather than a monotonic counter on purpose: it is the
    timeline sessions are written in, and it advances across every Windows
    power state, including the ones where a monotonic counter's behavior is not
    guaranteed. A clock stepped forward is reported too, which is correct — the
    timestamps on either side of the step cannot describe one continuous span.
    """

    def __init__(self, gap_seconds: float = UNOBSERVED_GAP_SECONDS):
        self._gap_seconds = gap_seconds
        self._last_seen = 0.0

    def gap_before(self, now: float) -> float:
        """Seconds missed before `now`; 0.0 when the loop kept up (or is new)."""
        previous = self._last_seen
        self._last_seen = now
        if not previous or now - previous < self._gap_seconds:
            return 0.0
        return now - previous


def _cleanup_step(label: str, action) -> bool:
    """Run one shutdown step without putting private exception text in logs."""
    try:
        action()
    except Exception as exc:
        logging.error(
            "Tracker shutdown step failed | step=%s | error=%s",
            label,
            type(exc).__name__,
        )
        return False
    return True


class _ShutdownCoordinator:
    """Run tracker cleanup once, keeping later safety steps independent."""

    def __init__(self, stop_event, tray_controller, power_monitor, manager, conn):
        self._stop_event = stop_event
        self._tray_controller = tray_controller
        self._power_monitor = power_monitor
        self._manager = manager
        self._conn = conn
        self._lock = threading.Lock()
        self._completed = threading.Event()
        self._owner_thread = None
        self._started = False

    def __call__(self, *_args) -> bool:
        current_thread = threading.get_ident()
        with self._lock:
            if self._started:
                if self._owner_thread == current_thread:
                    # A cleanup callback must not deadlock if it re-enters the
                    # coordinator on its own thread.
                    return True
                wait_for_completion = True
            else:
                # Mark before running callbacks: a console control event and
                # atexit can both reach this function, including from
                # different threads.
                self._started = True
                self._owner_thread = current_thread
                wait_for_completion = False
        if wait_for_completion:
            # A second callback must not let interpreter shutdown outrun the
            # first callback's session finalization and database close.
            self._completed.wait()
            return True

        try:
            self._stop_event.set()
            failed: list[str] = []
            if self._tray_controller is not None and not _cleanup_step(
                "tray", self._tray_controller.close
            ):
                failed.append("tray")
            if self._power_monitor is not None and not _cleanup_step(
                "power", self._power_monitor.close
            ):
                failed.append("power")
            if not _cleanup_step("sessions", lambda: self._manager.shutdown(time.time())):
                failed.append("sessions")
            if not _cleanup_step("health", lambda: stamp_tracker_health(self._conn, 0)):
                failed.append("health")
            if not _cleanup_step("database", self._conn.close):
                failed.append("database")
            if failed:
                logging.error(
                    "Tracker shutdown completed with cleanup errors | steps=%s",
                    ",".join(failed),
                )
            else:
                logging.info("Tracker stopped cleanly.")
        finally:
            self._completed.set()
        return True


def run() -> None:
    conn = db.open_db(config.DB_PATH)
    # Stamp the running tracker version so the dashboard can show both halves'
    # versions; a mismatched install is otherwise invisible in the field.
    db.set_setting(conn, "tracker_version", config.TRACKER_VERSION)
    raw_settings = db.read_settings_raw(conn)
    log_database_state(raw_settings)
    if os.environ.get("TIME_MIGRATE_ONLY") == "1":
        # Restore runs this packaged tracker once before the dashboard reopens
        # an older snapshot. The tracker remains the sole migration owner, but
        # no tray, probe, or recording loop should survive this maintenance run.
        conn.close()
        logging.info("Database migration check complete; exiting.")
        return
    if (
        raw_settings.get("privacy_onboarding_complete") != "1"
        and raw_settings.get("recording_consent") != "1"
    ):
        # Installer bootstrap: create the DB contract, but do not leave a
        # background process running before the user has seen the privacy screen.
        conn.close()
        logging.info("Database initialized; waiting for first-run privacy choice.")
        return
    manager = SessionManager(store=db.SqliteStore(conn), settings=db.get_settings(conn))
    media_monitor = media_playback.start_media_playback_monitor()
    power_monitor = power_events.start_power_event_monitor()
    stop_event = threading.Event()
    tray_controller = tray.create_tray_controller(config.DB_PATH, stop_event)
    tray_visible = _sync_tray(tray_controller, raw_settings)
    published_tray = _publish_tray_state(conn, tray_visible, None)
    shutdown = _ShutdownCoordinator(
        stop_event,
        tray_controller,
        power_monitor,
        manager,
        conn,
    )

    atexit.register(shutdown)
    try:
        import win32api

        win32api.SetConsoleCtrlHandler(shutdown, True)
    except Exception:
        pass  # pythonw has no console; atexit still covers normal interpreter exit

    logging.info(
        "Tracker started | tray_available=%s | tray_visible=%s |"
        " power_events=%s | media_playback=%s | poll=%ss",
        tray_controller is not None,
        tray_visible,
        power_monitor is not None,
        media_monitor is not None,
        config.POLL_SECONDS,
    )
    poll = config.POLL_SECONDS
    next_tick = time.monotonic()
    continuity = LoopContinuity()
    last_settings_refresh = 0.0
    last_health_publish = 0.0
    failures = FailureThrottle()

    while not stop_event.is_set():
        try:
            announced_boundary = False
            if power_monitor is not None:
                for event in power_monitor.drain():
                    announced_boundary = True
                    if event.kind == "suspend":
                        manager.system_suspended(event.at)
                        logging.info("System suspend detected; recording gap started.")
                    else:
                        manager.system_resumed(event.at)
                        logging.info(
                            "System resume detected; recording gap ended |"
                            " suspend_observed=%s",
                            event.suspend_observed,
                        )
            now = time.time()
            missed = continuity.gap_before(now)
            if missed and not announced_boundary:
                # Windows said nothing about a power boundary, so this is the
                # only notice the session state will get. Reporting it matters
                # as much as acting on it: a silent hole in an otherwise busy
                # day is exactly what a later field report has to explain.
                manager.unobserved_interval_ended(now)
                logging.info(
                    "Loop did not run for %.0fs with no power boundary"
                    " announced; that interval stays a gap.",
                    missed,
                )
            # Consent, pause, schedule, and title-privacy switches take effect
            # within one poll instead of waiting for the database heartbeat.
            if now - last_settings_refresh >= poll:
                manager.settings = db.get_settings(conn, now)
                if tray_controller is not None:
                    raw_settings = db.read_settings_raw(conn)
                    tray_active = _sync_tray(tray_controller, raw_settings, now)
                else:
                    # No controller at all — the optional UI packages are
                    # missing. Publish it rather than leaving the last value, or
                    # the dashboard reports a tray from a previous run.
                    tray_active = False
                published_tray = _publish_tray_state(conn, tray_active, published_tray)
                last_settings_refresh = now
            monotonic_now = time.monotonic()
            if monotonic_now - last_health_publish >= HEALTH_HEARTBEAT_SECONDS:
                stamp_tracker_health(conn, now)
                last_health_publish = monotonic_now
            snap = win32_probe.snapshot(now)
            if (
                media_monitor is not None
                and snap.process != LOCK_PROCESS
                and is_idle(snap, manager.settings)
            ):
                is_browser = (
                    snap.process is not None
                    and snap.process in manager.settings.browser_processes
                )
                domain = parse_domain(snap.title) if is_browser else None
                snap = replace(
                    snap,
                    media_playing=media_monitor.is_foreground_playing(
                        process=snap.process,
                        app_user_model_id=snap.app_user_model_id,
                        domain=domain,
                        browser_processes=manager.settings.browser_processes,
                        media_domains=manager.settings.media_domains,
                    ),
                )
            manager.tick(snap)
        except Exception as exc:
            failures.record("tick failed", exc, time.monotonic())

        next_tick += poll
        delay = next_tick - time.monotonic()
        if delay <= 0:  # resync after sleep/suspend/slow tick
            next_tick = time.monotonic() + poll
            delay = poll
        time.sleep(delay)


def main() -> int:
    """Entry point. Returns a process exit code; never raises past this frame.

    The packaged tracker runs windowless, so an unhandled exception would
    otherwise vanish with no console and no log, leaving a field report with
    nothing to report. Every startup path below ends in a log line or stderr.
    """
    try:
        set_up_logging()
    except Exception:
        # The log is the only channel a console-less tracker has. If it cannot
        # be opened, say so on stderr rather than dying silently.
        traceback.print_exc()
        return 1

    log_startup_environment()
    if not acquire_single_instance():
        logging.error("Another tracker instance is already running; exiting.")
        return 0
    try:
        run()
    except KeyboardInterrupt:
        return 0
    except db.SchemaTooNewError as exc:
        # Expected and self-explanatory: the user needs a newer Time, not a stack.
        logging.error("Startup aborted: %s", exc)
        return 1
    except Exception:
        logging.exception("Tracker exited on an unhandled error")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
