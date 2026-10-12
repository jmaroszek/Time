"""Shutdown callbacks must hand database cleanup back to its owning thread."""

import sqlite3
import subprocess
import sys
import threading
import uuid
from types import SimpleNamespace

from tracker import db, tracker
from tracker.session_manager import SessionManager, Settings, Snapshot
import pytest


def test_callback_shutdown_flushes_on_database_owner(tmp_path, monkeypatch, caplog):
    path = tmp_path / "shutdown.db"
    conn = db.open_db(path)
    manager = SessionManager(db.SqliteStore(conn), Settings())
    manager.tick(Snapshot(1000, 0, "editor.exe", ""))
    tracker.stamp_tracker_health(conn, 1000)
    monkeypatch.setattr(tracker, "time", SimpleNamespace(time=lambda: 1020))
    stop = threading.Event()
    shutdown = tracker._ShutdownCoordinator(stop, None, None, manager, conn)
    callback = threading.Thread(target=shutdown)
    callback.start()
    try:
        assert stop.wait(timeout=1)
        shutdown()
    finally:
        callback.join(timeout=5)
    assert not callback.is_alive()
    with sqlite3.connect(path) as check:
        assert check.execute("SELECT end_ts FROM sessions").fetchone()[0] == 1020
        assert check.execute(
            "SELECT value FROM settings WHERE key='tracker_health_heartbeat'"
        ).fetchone()[0] == "0"
    assert "cleanup errors" not in caplog.text


def test_mutex_failure_cannot_start_an_unprotected_recorder(monkeypatch):
    def create_mutex(*_):
        return None
    monkeypatch.setattr(tracker.ctypes, "WinDLL", lambda *_a, **_k:
                        SimpleNamespace(CreateMutexW=create_mutex))
    monkeypatch.setattr(tracker.ctypes, "get_last_error", lambda: 5)
    with pytest.raises(OSError):
        tracker.acquire_single_instance()
    monkeypatch.setattr(tracker, "set_up_logging", lambda: None)
    monkeypatch.setattr(tracker, "log_startup_environment", lambda: None)
    monkeypatch.setattr(tracker, "run", lambda: pytest.fail("must not start without ownership"))
    assert tracker.main() == 1


def test_real_mutex_excludes_second_process_and_releases_on_exit():
    name = "Local\\TimeTrackerTest-" + uuid.uuid4().hex
    code = (
        "import sys; from tracker import tracker, config; "
        "config.MUTEX_NAME=sys.argv[1]; "
        "print(tracker.acquire_single_instance(),flush=True); sys.stdin.readline()"
    )
    first = subprocess.Popen([sys.executable, "-c", code, name], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        answer = first.stdout.readline()
        assert answer == "True\n", first.stderr.read() if not answer else answer
        second = subprocess.run([sys.executable, "-c", code, name], input="\n",
                                capture_output=True, text=True, timeout=10)
        assert second.returncode == 0, second.stderr
        assert second.stdout == "False\n"
    finally:
        first.communicate("\n", timeout=10)
    third = subprocess.run([sys.executable, "-c", code, name], input="\n",
                           capture_output=True, text=True, timeout=10)
    assert third.returncode == 0, third.stderr
    assert third.stdout == "True\n"
