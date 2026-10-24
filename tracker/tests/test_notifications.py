from __future__ import annotations

import json
import logging
import xml.etree.ElementTree as ET
from pathlib import Path

from tracker.platforms.windows.notifications import TIME_APP_ID, Notifier, toast_xml

REPOSITORY = Path(__file__).resolve().parents[2]


def test_the_app_id_is_the_installed_shortcut_identity():
    """Windows drops toasts for an ID no installed shortcut carries, silently."""
    config = json.loads(
        (REPOSITORY / "dashboard" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    assert TIME_APP_ID == config["identifier"]


def test_toast_carries_both_lines_and_is_silent():
    root = ET.fromstring(toast_xml("Time for a break", "You've been active for 60 minutes."))
    assert [t.text for t in root.iter("text")] == [
        "Time for a break",
        "You've been active for 60 minutes.",
    ]
    assert root.find("audio").get("silent") == "true"
    assert root.get("launch") is None


def test_toast_text_is_escaped():
    root = ET.fromstring(toast_xml("<a & b>", "c"))
    assert next(root.iter("text")).text == "<a & b>"


class _Recorder:
    def __init__(self):
        self.shown = []

    def show(self, toast):
        self.shown.append(toast)


def test_show_hands_the_built_toast_to_windows():
    windows = _Recorder()
    assert Notifier(windows, lambda xml: ("toast", xml)).show("t", "b")
    assert windows.shown == [("toast", toast_xml("t", "b"))]


def test_a_failing_toast_is_logged_by_type_and_never_raises(caplog):
    class _Broken:
        def show(self, toast):
            raise OSError("private detail")

    with caplog.at_level(logging.ERROR):
        assert not Notifier(_Broken(), lambda xml: xml).show("t", "b")
    assert "OSError" in caplog.text
    assert "private detail" not in caplog.text
