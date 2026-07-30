import threading

from tracker import db, tray


def _settings(path):
    conn = db.open_db(path)
    try:
        return db.read_settings_raw(conn)
    finally:
        conn.close()


def test_tray_pause_resume_callbacks_persist_state(tmp_path, monkeypatch):
    path = tmp_path / "tray.db"
    conn = db.open_db(path)
    conn.close()
    stop_event = threading.Event()
    actions = tray._TrayActions(path, stop_event)
    monkeypatch.setattr(tray._time, "time", lambda: 1_000.0)

    actions.pause_for(900)(None, None)
    paused = _settings(path)
    assert paused["tracking_paused"] == "0"
    assert paused["tracking_paused_until"] == "1900"
    assert actions.status_text(None).startswith("Paused until ")

    actions.pause_indefinitely(None, None)
    paused = _settings(path)
    assert paused["tracking_paused"] == "1"
    assert paused["tracking_paused_until"] == "0"
    assert actions.status_text(None) == "Paused"

    actions.resume(None, None)
    resumed = _settings(path)
    assert resumed["tracking_paused"] == "0"
    assert resumed["tracking_paused_until"] == "0"
    assert actions.status_text(None) == "Recording"


def test_tray_until_tomorrow_uses_midnight_boundary(tmp_path, monkeypatch):
    path = tmp_path / "tray.db"
    conn = db.open_db(path)
    conn.close()
    actions = tray._TrayActions(path, threading.Event())
    monkeypatch.setattr(tray, "_next_midnight", lambda: 86_400.0)

    actions.pause_until_tomorrow(None, None)

    settings = _settings(path)
    assert settings["tracking_paused"] == "0"
    assert settings["tracking_paused_until"] == "86400"


def test_tray_open_dashboard_and_quit_callbacks(tmp_path, monkeypatch):
    dashboard = tmp_path / "Time.exe"
    dashboard.touch()
    calls = []
    monkeypatch.setattr(tray, "_dashboard_path", lambda: dashboard)
    monkeypatch.setattr(
        tray.subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs)),
    )
    stop_event = threading.Event()
    actions = tray._TrayActions(tmp_path / "unused.db", stop_event)

    actions.open_dashboard(None, None)
    assert calls == [
        (
            [str(dashboard)],
            {"cwd": str(dashboard.parent), "close_fds": True},
        )
    ]

    class FakeIcon:
        stopped = False

        def stop(self):
            self.stopped = True

    icon = FakeIcon()
    actions.quit_tracker(icon, None)
    assert stop_event.is_set()
    assert icon.stopped
