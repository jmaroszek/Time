"""Always-on tracker entry point.

Run with:  pythonw tracker/tracker.py   (or python, for a console)

Responsibilities: single-instance guard, logging, supervised 1s loop, settings
refresh, graceful shutdown. All session logic lives in session_manager.
"""

from __future__ import annotations

import atexit
import ctypes
import logging
import platform
import sys
import threading
import time
import traceback
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker import config, db, tray, win32_probe
from tracker.session_manager import SessionManager

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
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (HEALTH_HEARTBEAT_KEY, str(int(now))),
    )


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
            logging.exception("%s (%s)", message, kind)
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


def run() -> None:
    conn = db.open_db(config.DB_PATH)
    # Stamp the running tracker version so the dashboard can show both halves'
    # versions; a mismatched install is otherwise invisible in the field.
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('tracker_version', ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (config.TRACKER_VERSION,),
    )
    raw_settings = db.read_settings_raw(conn)
    log_database_state(raw_settings)
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

    def _shutdown(*_args) -> bool:
        try:
            manager.shutdown(time.time())
            stamp_tracker_health(conn, 0)
            conn.close()
            logging.info("Tracker stopped cleanly.")
        except Exception:
            pass
        return True

    atexit.register(_shutdown)
    try:
        import win32api

        win32api.SetConsoleCtrlHandler(_shutdown, True)
    except Exception:
        pass  # pythonw has no console; atexit still covers normal interpreter exit

    stop_event = threading.Event()
    has_tray = tray.start_tray(config.DB_PATH, stop_event)

    logging.info("Tracker started | tray=%s | poll=%ss", has_tray, config.POLL_SECONDS)
    poll = config.POLL_SECONDS
    next_tick = time.monotonic()
    last_settings_refresh = 0.0
    last_health_publish = 0.0
    failures = FailureThrottle()

    while not stop_event.is_set():
        try:
            now = time.time()
            # Consent, pause, and title-privacy switches take effect within one
            # poll instead of waiting for the database heartbeat interval.
            if now - last_settings_refresh >= poll:
                manager.settings = db.get_settings(conn)
                last_settings_refresh = now
            monotonic_now = time.monotonic()
            if monotonic_now - last_health_publish >= HEALTH_HEARTBEAT_SECONDS:
                stamp_tracker_health(conn, now)
                last_health_publish = monotonic_now
            snap = win32_probe.snapshot(now)
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
