import threading
import time

import pystray
import pytest

from tracker import db, tray
from tracker.tracking_schedule import schedule_state


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

    class FakeIcon:
        title = ""

    icon = FakeIcon()
    actions.pause_for(900)(icon, None)
    paused = _settings(path)
    assert paused["tracking_paused"] == "0"
    assert paused["tracking_paused_until"] == "1900"
    assert icon.title.startswith("Time: paused until ")

    actions.pause_indefinitely(icon, None)
    paused = _settings(path)
    assert paused["tracking_paused"] == "1"
    assert paused["tracking_paused_until"] == "0"
    assert icon.title == "Time: paused"

    actions.resume(icon, None)
    resumed = _settings(path)
    assert resumed["tracking_paused"] == "0"
    assert resumed["tracking_paused_until"] == "0"
    assert icon.title == "Time: recording"


def test_tray_pause_write_rolls_back_both_keys_on_partial_failure(tmp_path, monkeypatch):
    path = tmp_path / "tray-atomic.db"
    conn = db.open_db(path)
    conn.close()
    tray._write_pause(path, "1", 1900)

    def fail_after_first_write(conn, _values):
        conn.execute(
            "UPDATE settings SET value='0' WHERE key='tracking_paused'"
        )
        raise RuntimeError("second pause setting failed")

    monkeypatch.setattr(tray, "set_settings", fail_after_first_write)
    with pytest.raises(RuntimeError):
        tray._write_pause(path, "0", 2900)

    state = _settings(path)
    assert state["tracking_paused"] == "1"
    assert state["tracking_paused_until"] == "1900"


def test_tray_tooltip_distinguishes_recording_and_pause_states():
    one_pm = tray._dt.datetime(2026, 7, 30, 13, 0).timestamp()
    assert tray._tooltip_text(False, 0, now=1_000) == "Time: recording"
    assert tray._tooltip_text(True, 0, now=1_000) == "Time: paused"
    assert (
        tray._tooltip_text(True, one_pm, now=one_pm - 60)
        == "Time: paused until 1:00 PM"
    )
    outside = schedule_state(
        {
            "tracking_schedule_enabled": "1",
            "tracking_schedule_days": "",
        },
        now=1_000,
    )
    assert (
        tray._tooltip_text(False, 0, outside, now=1_000)
        == "Time: outside scheduled hours"
    )


def test_tray_menu_uses_default_dashboard_and_one_state_action(tmp_path, monkeypatch):
    path = tmp_path / "tray.db"
    conn = db.open_db(path)
    conn.close()
    dashboard = tmp_path / "Time.exe"
    dashboard.touch()
    monkeypatch.setattr(tray, "_dashboard_path", lambda: dashboard)
    actions = tray._TrayActions(path, threading.Event())

    menu = tray._build_menu(pystray, actions)
    items = menu.items
    assert [str(item.text) for item in items] == [
        "Open dashboard",
        "- - - -",
        "Pause tracking",
        "Resume tracking",
        "- - - -",
        "Send feedback",
        "Quit tracker",
    ]
    assert items[0].default is True
    assert items[2].visible is True
    assert items[3].visible is False

    tray._write_pause(path, "1", 0)
    assert items[2].visible is False
    assert items[3].visible is True


def test_pause_menu_matches_caffeine_durations_plus_until_resumed(tmp_path):
    actions = tray._TrayActions(tmp_path / "unused.db", threading.Event())
    seconds = []
    actions.pause_for = lambda duration: seconds.append(duration) or (lambda *_: None)

    menu = tray._build_menu(pystray, actions)
    pause_items = menu.items[2].submenu.items

    assert [str(item.text) for item in pause_items] == [
        "15 minutes",
        "30 minutes",
        "45 minutes",
        "- - - -",
        "1 hour",
        "2 hours",
        "4 hours",
        "6 hours",
        "8 hours",
        "10 hours",
        "24 hours",
        "- - - -",
        "Until resumed",
    ]
    assert seconds == [
        15 * 60,
        30 * 60,
        45 * 60,
        60 * 60,
        2 * 60 * 60,
        4 * 60 * 60,
        6 * 60 * 60,
        8 * 60 * 60,
        10 * 60 * 60,
        24 * 60 * 60,
    ]


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
    expected_kwargs = {"cwd": str(dashboard.parent), "close_fds": True}
    if hasattr(tray.subprocess, "CREATE_NO_WINDOW"):
        expected_kwargs["creationflags"] = tray.subprocess.CREATE_NO_WINDOW
    assert calls == [
        (
            [str(dashboard)],
            expected_kwargs,
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


class _FakeMenu(tuple):
    SEPARATOR = object()

    def __new__(cls, *items):
        return tuple.__new__(cls, items)


class _FakeMenuItem:
    def __init__(self, text, action, **kwargs):
        self.text = text
        self.action = action
        self.kwargs = kwargs


class _FakeIcon:
    def __init__(self, _name, _image, title, menu):
        self.title = title
        self.menu = menu
        self.visible = False
        self.stopped = threading.Event()
        self.menu_updates = 0

    def run(self, setup):
        setup(self)
        self.stopped.wait(timeout=2)

    def stop(self):
        self.stopped.set()

    def update_menu(self):
        self.menu_updates += 1


class _FakePystray:
    Menu = _FakeMenu
    MenuItem = _FakeMenuItem

    def __init__(self):
        self.icons = []

    def Icon(self, *args):
        icon = _FakeIcon(*args)
        self.icons.append(icon)
        return icon


def test_tray_controller_hides_and_recreates_without_stopping_tracker(
    tmp_path, monkeypatch
):
    path = tmp_path / "tray.db"
    conn = db.open_db(path)
    conn.close()
    pystray_fake = _FakePystray()
    monkeypatch.setattr(tray, "_load_icon", lambda *_args: object())
    stop_event = threading.Event()
    controller = tray.TrayController(
        path,
        stop_event,
        pystray_fake,
        object(),
        object(),
    )

    assert controller.set_enabled(True) is True
    first = pystray_fake.icons[0]
    for _ in range(50):
        if first.visible:
            break
        time.sleep(0.01)
    assert first.visible is True
    assert controller.set_enabled(True) is True
    assert len(pystray_fake.icons) == 1

    controller.sync_state(True, 0, schedule_state({}))
    assert first.title == "Time: paused"
    assert first.menu_updates == 1

    assert controller.set_enabled(False) is False
    assert first.stopped.is_set()
    assert stop_event.is_set() is False

    assert controller.set_enabled(True) is True
    assert len(pystray_fake.icons) == 2
    controller.close()
    assert pystray_fake.icons[1].stopped.is_set()


def test_tray_send_feedback_opens_a_support_draft(tmp_path, monkeypatch):
    opened = []
    monkeypatch.setattr(tray.os, "startfile", opened.append, raising=False)
    actions = tray._TrayActions(tmp_path / "unused.db", threading.Event())

    actions.send_feedback(None, None)

    assert len(opened) == 1
    url = opened[0]
    assert url.startswith("mailto:support@trackwithtime.com?subject=")
    # Pinned against the dashboard's own subject: the two runtimes build this
    # draft independently, and a drift would split one reader's conversation
    # across two inbox threads. See dashboard/src/lib/support.ts.
    assert "subject=Time%20support%20or%20feedback" in url
    assert "&body=" in url


def test_tray_send_feedback_survives_a_machine_with_no_mail_client(tmp_path, monkeypatch):
    def explode(_url):
        raise OSError("no handler registered")

    monkeypatch.setattr(tray.os, "startfile", explode, raising=False)
    actions = tray._TrayActions(tmp_path / "unused.db", threading.Event())

    # No handler is a dead menu item, not a dead tracker.
    actions.send_feedback(None, None)
