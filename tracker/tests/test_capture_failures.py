"""Drive the real recording loop through capture failures without Win32 probes."""

import sqlite3
import sys
from types import SimpleNamespace

import pytest

from tracker import db, tracker
from tracker.session_manager import Snapshot


def drive_loop(tmp_path, monkeypatch, snapshots, *, input_monitor=None, media_monitor=None, probe_inputs=None):
    path = tmp_path / "capture.db"
    conn = db.open_db(path)
    db.set_settings(conn, {"recording_consent": "1", "privacy_onboarding_complete": "1"})
    conn.close()
    monkeypatch.setattr(tracker.config, "DB_PATH", path)
    monkeypatch.delenv("TIME_MIGRATE_ONLY", raising=False)
    monkeypatch.setattr(tracker.platforms, "start_human_input_monitor", lambda: input_monitor)
    monkeypatch.setattr(tracker.platforms, "start_media_playback_monitor", lambda: media_monitor)
    monkeypatch.setattr(tracker.platforms, "start_power_event_monitor", lambda: None)
    monkeypatch.setitem(sys.modules, "win32api", SimpleNamespace(SetConsoleCtrlHandler=lambda *_: None))
    step = 0
    health = []
    def tray(_path, event):
        def wait(_):
            nonlocal step
            with sqlite3.connect(path) as check:
                row = check.execute("SELECT value FROM settings WHERE key='tracker_health_heartbeat'").fetchone()
                health.append(int(row[0]) if row else 0)
            step += 1
            if step == len(snapshots):
                event.set()
        event.wait = wait
        return None
    monkeypatch.setattr(tracker.tray, "create_tray_controller", tray)
    monkeypatch.setattr(tracker, "time", SimpleNamespace(
        time=lambda: 1000 + step * 10, monotonic=lambda: 100 + step * 10,
    ))
    def probe(now, **kwargs):
        if probe_inputs is not None:
            probe_inputs.append(kwargs.get("idle_seconds"))
        value = snapshots[step]
        if isinstance(value, Exception):
            raise value
        return Snapshot(now, value[1], value[0], "")
    monkeypatch.setattr(tracker.platforms, "snapshot", probe)
    tracker.run()
    with sqlite3.connect(path) as check:
        rows = check.execute("SELECT start_ts,end_ts,process FROM sessions ORDER BY id").fetchall()
    return rows, health


def test_capture_failure_does_not_claim_healthy_recording_or_fill_gap(tmp_path, monkeypatch):
    rows, health = drive_loop(tmp_path, monkeypatch, [
        ("editor.exe", 0), OSError("probe failed"), OSError("probe failed"), ("editor.exe", 0),
    ])
    assert health == [1000, 1000, 1000, 1030]
    assert rows == [(1000, 1000, "editor.exe"), (1030, 1040, "editor.exe")]


def test_shutdown_during_capture_outage_does_not_fill_unobserved_time(tmp_path, monkeypatch):
    rows, health = drive_loop(tmp_path, monkeypatch, [
        ("editor.exe", 0), OSError("probe failed"), OSError("probe failed"),
    ])
    assert rows == [(1000, 1000, "editor.exe")]
    assert health == [1000, 1000, 1000]


def test_input_monitor_failure_falls_back_and_can_recover(tmp_path, monkeypatch):
    calls = []
    def idle():
        calls.append(True)
        if len(calls) == 2:
            raise OSError("input read failed")
        return 0
    monitor = SimpleNamespace(idle_seconds=idle, close=lambda: None)
    observed = []
    rows, health = drive_loop(tmp_path, monkeypatch, [("editor.exe", 0)] * 3,
                              input_monitor=monitor, probe_inputs=observed)
    assert len(calls) == 3
    assert observed == [0, None, 0]
    assert health == [1000, 1010, 1020]
    assert rows == [(1000, 1030, "editor.exe")]


@pytest.mark.parametrize("idle", [0, 600])
def test_prolonged_missing_foreground_does_not_extend_previous_app(tmp_path, monkeypatch, idle):
    rows, health = drive_loop(tmp_path, monkeypatch,
                              [("editor.exe", 0)] + [(None, 0)] * 7 + [("editor.exe", idle)])
    assert rows == [(1000, 1000, "editor.exe"), (1080, 1090, "editor.exe")]
    assert health == [1000] * 8 + [1080]
