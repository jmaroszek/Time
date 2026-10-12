"""Real SQLite failures and process exits, confined to scratch databases."""

import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from tracker import db
from tracker.power_events import PowerEvent
from tracker.session_manager import SessionManager, Settings, Snapshot
from tracker.tracker import LoopContinuity


def snapshot(now, process="editor.exe", idle=0):
    return Snapshot(now, idle, process, "")


@pytest.fixture
def storage(tmp_path, monkeypatch):
    path = tmp_path / "database.db"
    conn = db.open_db(path)
    conn.execute("PRAGMA busy_timeout=1")
    # Keep the real SQLite errors and production retry loop; skip only backoff.
    monkeypatch.setattr(db.time, "sleep", lambda _: None)
    manager = SessionManager(db.SqliteStore(conn), Settings())
    with sqlite3.connect(path, isolation_level=None) as blocker:
        yield conn, blocker, manager
    conn.close()


@pytest.mark.parametrize("operation", ["open", "heartbeat", "close"])
def test_lock_exhaustion_leaves_committed_rows_intact_and_recovers(storage, operation):
    conn, blocker, manager = storage
    if operation != "open":
        manager.tick(snapshot(1000))
    before = list(conn.execute("SELECT * FROM sessions"))
    blocker.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            manager.tick(snapshot(1020, "other.exe" if operation == "close" else "editor.exe"))
        assert list(conn.execute("SELECT * FROM sessions")) == before
    finally:
        blocker.execute("ROLLBACK")
    manager.tick(snapshot(1021, "other.exe" if operation == "close" else "editor.exe"))
    manager.shutdown(1022)
    rows = [tuple(row) for row in conn.execute(
        "SELECT start_ts,end_ts,process FROM sessions ORDER BY id"
    )]
    expected = ([(1000, 1021, "editor.exe"), (1021, 1022, "other.exe")]
                if operation == "close" else
                [(1021 if operation == "open" else 1000, 1022, "editor.exe")])
    assert rows == expected
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_lock_released_during_backoff_retries_exactly_one_insert(storage, monkeypatch):
    conn, blocker, manager = storage
    blocker.execute("BEGIN IMMEDIATE")
    monkeypatch.setattr(db.time, "sleep", lambda _: blocker.execute("ROLLBACK"))
    manager.tick(snapshot(1000))
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


@pytest.mark.parametrize("announced", [True, False])
def test_failed_sleep_boundary_is_retried_before_recording(storage, announced):
    conn, blocker, manager = storage
    continuity = LoopContinuity()
    manager.tick(snapshot(1000))
    continuity.apply_boundaries(manager, [], 1000)
    manager.tick(snapshot(1010))
    events = [PowerEvent("suspend", 1011), PowerEvent("resume", 1020)] if announced else []
    wake = 1020 if announced else 1100
    blocker.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            continuity.apply_boundaries(manager, events, wake)
    finally:
        blocker.execute("ROLLBACK")
    continuity.apply_boundaries(manager, [], wake + 1)
    manager.tick(snapshot(wake + 1, idle=600))
    manager.shutdown(wake + 2)
    assert [tuple(row) for row in conn.execute(
        "SELECT start_ts,end_ts,is_afk FROM sessions ORDER BY id"
    )] == [(1000, 1011 if announced else 1010, 0), (wake, wake + 2, 1)]


def test_sqlite_full_does_not_open_a_partial_session_and_recovers(storage):
    conn, _, manager = storage
    manager.tick(snapshot(1000))
    pages = conn.execute("PRAGMA page_count").fetchone()[0]
    conn.execute(f"PRAGMA max_page_count={pages}")
    # Force page allocation in the same INSERT used by the real recorder.
    with pytest.raises(sqlite3.OperationalError) as failure:
        manager.tick(snapshot(1010, "x" * 100_000))
    assert failure.value.sqlite_errorcode == sqlite3.SQLITE_FULL
    assert [tuple(row) for row in conn.execute(
        "SELECT start_ts,end_ts,process FROM sessions"
    )] == [(1000, 1010, "editor.exe")]
    conn.execute("PRAGMA max_page_count=1073741823")
    manager.tick(snapshot(1020, "other.exe"))
    manager.shutdown(1021)
    assert [tuple(row) for row in conn.execute(
        "SELECT start_ts,end_ts FROM sessions ORDER BY id"
    )] == [(1000, 1010), (1020, 1021)]
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_killed_recorder_keeps_last_heartbeat_and_restart_does_not_backdate(tmp_path):
    root = tmp_path / "test-scratch"
    root.mkdir()
    path = root / "database.db"
    conn = db.open_db(path)
    db.set_setting(conn, "recording_consent", "1")
    conn.close()
    worker = Path(__file__).with_name("interop_worker.py")
    child = subprocess.Popen(
        [sys.executable, str(worker), str(path)], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        ready = child.stdout.readline()
        assert ready, child.stderr.read()
        assert json.loads(ready) == {"ready": True}
        for now in [1000, 1020, 1021]:
            child.stdin.write(json.dumps({"now": now}) + "\n")
            child.stdin.flush()
            json.loads(child.stdout.readline())
        child.kill()
        child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)
    conn = db.open_db(path)
    try:
        assert db.latest_session_end(conn) == 1020
        manager = SessionManager(db.SqliteStore(conn), Settings(), db.latest_session_end(conn))
        manager.tick(snapshot(1100, idle=600))
        manager.shutdown(1101)
        assert [tuple(row) for row in conn.execute(
            "SELECT start_ts,end_ts FROM sessions ORDER BY id"
        )] == [(1000, 1020), (1100, 1101)]
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()
