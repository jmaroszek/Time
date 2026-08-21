"""System-tray presence for the tracker: status, pause/resume, quit.

Runs in a daemon thread beside the 1 Hz loop. All state flows through the
settings table (the DB contract), so the tracker itself picks pauses up on its
normal settings-refresh cycle and the dashboard can display the same state.

pystray (and Pillow, for the icon) are optional: without them the tracker runs
unchanged, just without a tray icon.
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
import sqlite3
import subprocess
import sys
import threading
import time as _time
from pathlib import Path

from tracker.db import is_paused, pause_until, set_settings
from tracker.tracking_schedule import ScheduleState, schedule_state

_DEV_ICON_PATH = Path(__file__).resolve().parent.parent / "dashboard/src-tauri/icons/icon.ico"


def _icon_path() -> Path:
    """Resolve the icon in both source and PyInstaller one-dir layouts."""
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        frozen_icon = Path(bundle_root) / "assets" / "icon.ico"
        if frozen_icon.is_file():
            return frozen_icon
    return _DEV_ICON_PATH


def _dashboard_path() -> Path | None:
    """Return the installed dashboard beside the packaged tracker, if present."""
    override = None if getattr(sys, "frozen", False) else os.environ.get("TIME_DASHBOARD_PATH")
    if override:
        candidate = Path(override)
    elif getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().with_name("Time.exe")
    else:
        candidate = (
            Path(__file__).resolve().parent.parent
            / "dashboard"
            / "src-tauri"
            / "target"
            / "release"
            / "Time.exe"
        )
    return candidate if candidate.is_file() else None


def _write_pause(db_path: str | Path, paused: str, until: float) -> None:
    """Set both pause keys in one short-lived connection (tray-thread only)."""
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    try:
        # The tracker reads the two keys independently on its refresh poll, so
        # a half-written pause must never be observable as a new state.
        conn.execute("BEGIN")
        try:
            set_settings(
                conn,
                {
                    "tracking_paused": paused,
                    "tracking_paused_until": str(int(until)),
                },
            )
        except Exception:
            conn.rollback()
            raise
        conn.commit()
    finally:
        conn.close()


def _read_pause_state(db_path: str | Path) -> tuple[bool, float]:
    paused, until, _schedule = _read_tracker_state(db_path)
    return paused, until


def _read_tracker_state(db_path: str | Path) -> tuple[bool, float, ScheduleState]:
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    try:
        rows = dict(
            conn.execute(
                "SELECT key, value FROM settings WHERE key IN"
                " ('tracking_paused','tracking_paused_until',"
                "'tracking_schedule_enabled','tracking_schedule_days',"
                "'tracking_schedule_start_minute','tracking_schedule_end_minute')"
            )
        )
    finally:
        conn.close()
    # db.py owns how a settings row is read, the same way schedule_state below
    # owns the schedule. Parsing these two keys here instead drifted once
    # already: this end caught only ValueError, so a NULL value — settings.value
    # is nullable — raised TypeError out of the tray thread rather than reading
    # as "not paused".
    return is_paused(rows), pause_until(rows), schedule_state(rows)


class _TrayActions:
    """Testable callback boundary between pystray and Time's persisted state."""

    def __init__(self, db_path: str | Path, stop_event: threading.Event):
        self.db_path = db_path
        self.stop_event = stop_event

    def pause_state(self) -> tuple[bool, float]:
        return _read_pause_state(self.db_path)

    def is_paused(self, _item=None) -> bool:
        return self.pause_state()[0]

    def is_recording(self, _item=None) -> bool:
        return not self.is_paused()

    def tooltip_text(self) -> str:
        paused, until, recording_schedule = _read_tracker_state(self.db_path)
        return _tooltip_text(paused, until, recording_schedule)

    def _refresh_icon_title(self, icon) -> None:
        icon.title = self.tooltip_text()

    def pause_for(self, seconds: float):
        def action(icon, _item) -> None:
            _write_pause(self.db_path, "0", _time.time() + seconds)
            self._refresh_icon_title(icon)

        return action

    def pause_indefinitely(self, icon, _item) -> None:
        _write_pause(self.db_path, "1", 0)
        self._refresh_icon_title(icon)

    def resume(self, icon, _item) -> None:
        _write_pause(self.db_path, "0", 0)
        self._refresh_icon_title(icon)

    def open_dashboard(self, _icon, _item) -> None:
        path = _dashboard_path()
        if path is None:
            return
        try:
            subprocess.Popen([str(path)], cwd=str(path.parent), close_fds=True)
        except OSError:
            logging.exception("Could not open the Time dashboard")

    def quit_tracker(self, icon, _item) -> None:
        self.stop_event.set()
        icon.stop()


def _tooltip_text(
    paused: bool,
    until: float,
    recording_schedule: ScheduleState | None = None,
    now: float | None = None,
) -> str:
    current = _time.time() if now is None else now
    if paused:
        if until > current:
            short_time = _dt.datetime.fromtimestamp(until).strftime("%I:%M %p").lstrip("0")
            return f"Time: paused until {short_time}"
        return "Time: paused"
    if recording_schedule is not None and not recording_schedule.recording_allowed:
        if recording_schedule.next_start is not None:
            next_start = _dt.datetime.fromtimestamp(recording_schedule.next_start)
            day = next_start.strftime("%a")
            short_time = next_start.strftime("%I:%M %p").lstrip("0")
            return f"Time: scheduled - resumes {day} at {short_time}"
        return "Time: outside scheduled hours"
    return "Time: recording"


def _build_menu(pystray, actions: _TrayActions):
    """Create the native menu in task order, with one state-relevant control."""
    pause_menu = pystray.Menu(
        pystray.MenuItem("15 minutes", actions.pause_for(15 * 60)),
        pystray.MenuItem("30 minutes", actions.pause_for(30 * 60)),
        pystray.MenuItem("45 minutes", actions.pause_for(45 * 60)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("1 hour", actions.pause_for(60 * 60)),
        pystray.MenuItem("2 hours", actions.pause_for(2 * 60 * 60)),
        pystray.MenuItem("4 hours", actions.pause_for(4 * 60 * 60)),
        pystray.MenuItem("6 hours", actions.pause_for(6 * 60 * 60)),
        pystray.MenuItem("8 hours", actions.pause_for(8 * 60 * 60)),
        pystray.MenuItem("10 hours", actions.pause_for(10 * 60 * 60)),
        pystray.MenuItem("24 hours", actions.pause_for(24 * 60 * 60)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Until resumed", actions.pause_indefinitely),
    )
    return pystray.Menu(
        pystray.MenuItem(
            "Open dashboard",
            actions.open_dashboard,
            default=True,
            visible=lambda _item: _dashboard_path() is not None,
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Pause tracking",
            pause_menu,
            visible=actions.is_recording,
        ),
        pystray.MenuItem(
            "Resume tracking",
            actions.resume,
            visible=actions.is_paused,
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit tracker", actions.quit_tracker),
    )


def _load_icon(Image, ImageDraw):
    try:
        return Image.open(_icon_path())
    except Exception:
        # Fallback: the app's dark-clock look, minus the clock.
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse(
            (4, 4, 60, 60),
            fill=(22, 24, 29, 255),
            outline=(22, 185, 129, 255),
            width=6,
        )
        return img


class TrayController:
    """Own one recreatable pystray icon without owning the tracker process."""

    def __init__(
        self,
        db_path: str | Path,
        stop_event: threading.Event,
        pystray,
        Image,
        ImageDraw,
    ):
        self._actions = _TrayActions(db_path, stop_event)
        self._pystray = pystray
        self._Image = Image
        self._ImageDraw = ImageDraw
        self._lock = threading.RLock()
        self._enabled = False
        self._icon = None
        self._thread: threading.Thread | None = None
        self._state: tuple[bool, float, bool, float | None] | None = None

    @property
    def enabled(self) -> bool:
        with self._lock:
            return self._enabled

    def _new_icon(self):
        return self._pystray.Icon(
            "time-tracker",
            _load_icon(self._Image, self._ImageDraw),
            self._actions.tooltip_text(),
            _build_menu(self._pystray, self._actions),
        )

    def _run_icon(self, icon) -> None:
        def setup(ready_icon) -> None:
            with self._lock:
                should_show = self._enabled and self._icon is ready_icon
            if should_show:
                ready_icon.visible = True
            else:
                ready_icon.stop()

        try:
            icon.run(setup)
        except Exception:
            logging.exception("Tray icon stopped unexpectedly")
        finally:
            with self._lock:
                if self._icon is icon:
                    self._icon = None
                    self._thread = None

    def set_enabled(self, enabled: bool) -> bool:
        """Apply visibility idempotently; hiding never touches stop_event."""
        icon_to_stop = None
        with self._lock:
            self._enabled = enabled
            if not enabled:
                icon_to_stop = self._icon
                self._icon = None
                self._thread = None
            elif self._icon is not None:
                return True
            else:
                try:
                    icon = self._new_icon()
                except Exception:
                    logging.exception("Could not create the tray icon")
                    self._enabled = False
                    return False
                thread = threading.Thread(
                    target=self._run_icon,
                    args=(icon,),
                    name="tray",
                    daemon=True,
                )
                self._icon = icon
                self._thread = thread
                thread.start()
                return True
        if icon_to_stop is not None:
            icon_to_stop.stop()
        return False

    def sync_state(
        self,
        paused: bool,
        until: float,
        recording_schedule: ScheduleState,
    ) -> None:
        """Refresh native state only when pause or schedule state changes."""
        state = (
            paused,
            until,
            recording_schedule.recording_allowed,
            recording_schedule.next_start,
        )
        with self._lock:
            if self._state == state:
                return
            self._state = state
            icon = self._icon
        if icon is not None:
            icon.title = _tooltip_text(paused, until, recording_schedule)
            icon.update_menu()

    def close(self) -> None:
        self.set_enabled(False)


def create_tray_controller(
    db_path: str | Path,
    stop_event: threading.Event,
) -> TrayController | None:
    """Return no controller when optional UI packages are unavailable."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        logging.info("pystray/Pillow not installed; running without a tray icon.")
        return None
    return TrayController(
        db_path,
        stop_event,
        pystray,
        Image,
        ImageDraw,
    )
