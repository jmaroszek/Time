"""Always-on tracker entry point.

Run with:  pythonw tracker/tracker.py   (or python, for a console)

Responsibilities: single-instance guard, logging, supervised 1s loop, settings
refresh, graceful shutdown. All session logic lives in session_manager.
"""

from __future__ import annotations

import atexit
import ctypes
import logging
import sys
import threading
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker import config, db, tray, win32_probe
from tracker.session_manager import SessionManager

_ERROR_ALREADY_EXISTS = 183
_mutex_handle = None  # keep a module-level reference so the handle lives forever


def acquire_single_instance() -> bool:
    global _mutex_handle
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Global\ so a second logon session (RDP, fast user switching) of the same
    # user cannot run a second tracker against the same DB (REL-005).
    _mutex_handle = kernel32.CreateMutexW(None, False, config.MUTEX_NAME)
    if not _mutex_handle:
        return True  # cannot check; do not block tracking over it
    return ctypes.get_last_error() != _ERROR_ALREADY_EXISTS


def set_up_logging() -> None:
    config.LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    handler = TimedRotatingFileHandler(
        filename=config.LOG_PATH, when="midnight", backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    logger.addHandler(handler)


def run() -> None:
    conn = db.open_db(config.DB_PATH)
    # DIST-005: stamp the running tracker version so the dashboard can show
    # both halves' versions (mismatch diagnosis in the field).
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('tracker_version', ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (config.TRACKER_VERSION,),
    )
    raw_settings = db.read_settings_raw(conn)
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
    tray.start_tray(config.DB_PATH, stop_event)

    logging.info("Tracker started.")
    poll = config.POLL_SECONDS
    next_tick = time.monotonic()
    last_settings_refresh = 0.0

    while not stop_event.is_set():
        try:
            now = time.time()
            # Consent, pause, and title-privacy switches take effect within one
            # poll instead of waiting for the database heartbeat interval.
            if now - last_settings_refresh >= poll:
                manager.settings = db.get_settings(conn)
                last_settings_refresh = now
            snap = win32_probe.snapshot(now)
            manager.tick(snap)
        except Exception:
            logging.exception("tick failed")

        next_tick += poll
        delay = next_tick - time.monotonic()
        if delay <= 0:  # resync after sleep/suspend/slow tick
            next_tick = time.monotonic() + poll
            delay = poll
        time.sleep(delay)


def main() -> None:
    set_up_logging()
    if not acquire_single_instance():
        logging.error("Another tracker instance is already running; exiting.")
        return
    try:
        run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
