"""Support-grade logging.

Two properties matter here: a failure must leave actionable evidence, and no
INFO-level line may carry a window title or a browser domain. The privacy tests
drive the real store and session manager rather than asserting on message
strings, so a future log line that leaks content fails them.
"""

import logging
import sqlite3
from logging.handlers import TimedRotatingFileHandler

import pytest

from tracker import config, db, tracker
from tracker.session_manager import Settings, Snapshot, SessionManager

# Distinctive enough that a substring match cannot pass by accident.
SECRET_TITLE = "Quarterly layoffs memo - CONFIDENTIAL - Microsoft Word"
SECRET_DOMAIN = "clinic-portal.example.com"
SECRET_BROWSER_TITLE = (
    f"Test results - https://{SECRET_DOMAIN}/patients/4821 - Google Chrome"
)


@pytest.fixture
def info_log(caplog):
    caplog.set_level(logging.DEBUG)
    return caplog


def _info_text(caplog) -> str:
    return "\n".join(
        r.getMessage() for r in caplog.records if r.levelno >= logging.INFO
    )


# --- Rotation -------------------------------------------------------------


def test_log_rotates_daily_and_keeps_seven_days(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOG_PATH", tmp_path / "Logs" / "tracker.log")
    try:
        tracker.set_up_logging()
        handler = logging.getLogger().handlers[0]
        assert isinstance(handler, TimedRotatingFileHandler)
        assert handler.when == "MIDNIGHT"
        assert handler.backupCount == tracker.LOG_RETENTION_DAYS == 7
    finally:
        logging.getLogger().handlers.clear()


def test_set_up_logging_creates_the_log_directory(tmp_path, monkeypatch):
    log_path = tmp_path / "nested" / "Logs" / "tracker.log"
    monkeypatch.setattr(config, "LOG_PATH", log_path)
    try:
        tracker.set_up_logging()
        assert log_path.parent.is_dir()
    finally:
        logging.getLogger().handlers.clear()


# --- Startup milestones ---------------------------------------------------


def test_startup_milestone_names_version_packaging_and_os(info_log):
    tracker.log_startup_environment()
    text = _info_text(info_log)
    assert config.TRACKER_VERSION in text
    assert "packaged=" in text
    assert "os=" in text
    assert "python=" in text


def test_database_milestone_reports_schema_and_privacy_gates(info_log, tmp_path):
    conn = db.open_db(tmp_path / "t.db")
    try:
        tracker.log_database_state(db.read_settings_raw(conn))
    finally:
        conn.close()
    text = _info_text(info_log)
    assert f"schema={db.SCHEMA_VERSION}" in text
    assert "consent=False" in text
    assert "titles=False" in text


def test_database_milestone_does_not_dump_raw_settings(info_log, tmp_path):
    conn = db.open_db(tmp_path / "t.db")
    try:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('browser_processes', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("secretbrowser.exe",),
        )
        tracker.log_database_state(db.read_settings_raw(conn))
    finally:
        conn.close()
    assert "secretbrowser.exe" not in _info_text(info_log)


# --- Fatal startup evidence -----------------------------------------------


def test_unhandled_startup_error_logs_a_traceback_and_exits_nonzero(
    info_log, monkeypatch
):
    monkeypatch.setattr(tracker, "set_up_logging", lambda: None)
    monkeypatch.setattr(tracker, "acquire_single_instance", lambda: True)

    def _boom() -> None:
        raise RuntimeError("disk went away")

    monkeypatch.setattr(tracker, "run", _boom)
    assert tracker.main() == 1
    text = info_log.text
    assert "Tracker exited on an unhandled error" in text
    assert "RuntimeError: disk went away" in text
    assert "Traceback" in text


def test_schema_too_new_is_reported_without_a_stack(info_log, monkeypatch):
    monkeypatch.setattr(tracker, "set_up_logging", lambda: None)
    monkeypatch.setattr(tracker, "acquire_single_instance", lambda: True)

    def _too_new() -> None:
        raise db.SchemaTooNewError("database schema 3 is newer than tracker schema 2")

    monkeypatch.setattr(tracker, "run", _too_new)
    assert tracker.main() == 1
    assert "Startup aborted: database schema 3 is newer" in info_log.text
    assert "Traceback" not in info_log.text


def test_second_instance_logs_and_exits_zero(info_log, monkeypatch):
    monkeypatch.setattr(tracker, "set_up_logging", lambda: None)
    monkeypatch.setattr(tracker, "acquire_single_instance", lambda: False)
    assert tracker.main() == 0
    assert "already running" in info_log.text


def test_unopenable_log_reports_on_stderr_instead_of_dying_silently(
    monkeypatch, capsys
):
    def _no_log() -> None:
        raise OSError("log directory is read-only")

    monkeypatch.setattr(tracker, "set_up_logging", _no_log)
    assert tracker.main() == 1
    assert "log directory is read-only" in capsys.readouterr().err


# --- Retry exhaustion -----------------------------------------------------


def test_retry_logs_each_attempt_and_the_final_exhaustion(info_log, monkeypatch):
    monkeypatch.setattr(db.time, "sleep", lambda _s: None)

    def _locked():
        raise sqlite3.OperationalError("database is locked")

    with pytest.raises(sqlite3.OperationalError):
        db._retry(_locked, attempts=3, op="open_session")

    warnings = [r for r in info_log.records if r.levelno == logging.WARNING]
    errors = [r for r in info_log.records if r.levelno == logging.ERROR]
    assert len(warnings) == 2
    assert "SQLite open_session retry 1 of 2" in warnings[0].getMessage()
    assert len(errors) == 1
    assert "failed after 3 attempts" in errors[0].getMessage()
    assert "data was lost" in errors[0].getMessage()


def test_successful_retry_is_silent_at_error_level(info_log, monkeypatch):
    monkeypatch.setattr(db.time, "sleep", lambda _s: None)
    calls = {"n": 0}

    def _flaky() -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return "ok"

    assert db._retry(_flaky, op="heartbeat") == "ok"
    assert not [r for r in info_log.records if r.levelno >= logging.ERROR]


# --- Bounded logs under a repeating fault ---------------------------------


def test_repeating_tick_failure_logs_once_then_summarizes(info_log):
    throttle = tracker.FailureThrottle(summary_seconds=60.0)
    exc = ValueError("probe failed")
    for i in range(200):  # ~3.3 minutes of 1 Hz ticks
        throttle.record("tick failed", exc, now=float(i))

    records = [r for r in info_log.records if r.levelno >= logging.ERROR]
    # One traceback plus one summary per elapsed minute, not 200 lines.
    assert len(records) == 4
    assert records[0].exc_info is not None
    assert "further ValueError failures" in records[1].getMessage()


def test_a_new_failure_kind_still_gets_its_own_traceback(info_log):
    throttle = tracker.FailureThrottle()
    throttle.record("tick failed", ValueError("first"), now=0.0)
    throttle.record("tick failed", OSError("second"), now=1.0)
    with_stacks = [r for r in info_log.records if r.exc_info is not None]
    assert len(with_stacks) == 2


# --- Privacy: no titles or domains at INFO --------------------------------


def test_session_writes_keep_titles_and_domains_out_of_info_logs(info_log, tmp_path):
    """Drive real writes through the real store, then read back the log."""
    conn = db.open_db(tmp_path / "t.db")
    try:
        store = db.SqliteStore(conn)
        manager = SessionManager(
            store=store,
            settings=Settings(recording_consent=True, record_window_titles=True),
        )
        now = 1_000_000.0
        for i in range(30):
            manager.tick(
                Snapshot(
                    now=now + i,
                    idle_seconds=0.0,
                    process="chrome.exe" if i < 15 else "winword.exe",
                    title=SECRET_BROWSER_TITLE if i < 15 else SECRET_TITLE,
                )
            )
        manager.shutdown(now + 30)

        # The sensitive values really did reach the database...
        stored = conn.execute("SELECT title, domain FROM sessions").fetchall()
        assert any(SECRET_DOMAIN == row["domain"] for row in stored)
        assert any(SECRET_TITLE == row["title"] for row in stored)
    finally:
        conn.close()

    # ...but no INFO line mentions them.
    text = _info_text(info_log)
    assert SECRET_TITLE not in text
    assert SECRET_DOMAIN not in text
    assert "layoffs" not in text.lower()
    assert "patients" not in text.lower()


def test_titles_appear_only_at_debug(info_log, tmp_path):
    """The DEBUG carve-out is intentional; this pins where the line sits."""
    conn = db.open_db(tmp_path / "t.db")
    try:
        db.SqliteStore(conn).open_session(1.0, "winword.exe", SECRET_TITLE, None, False)
    finally:
        conn.close()
    debug_text = "\n".join(
        r.getMessage() for r in info_log.records if r.levelno == logging.DEBUG
    )
    assert SECRET_TITLE[:40] in debug_text
    assert SECRET_TITLE not in _info_text(info_log)
