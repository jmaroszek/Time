"""System-tray presence for the tracker: status, pause/resume, quit.

Runs in a daemon thread beside the 1 Hz loop. All state flows through the
settings table (the DB contract), so the tracker itself picks pauses up on its
normal settings-refresh cycle and the dashboard can display the same state.

pystray (and Pillow, for the icon) are optional: without them the tracker runs
exactly as before, just without a tray icon.
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

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
    override = os.environ.get("TIME_DASHBOARD_PATH")
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
        conn.executemany(
            "INSERT INTO settings (key, value) VALUES (?,?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [("tracking_paused", paused), ("tracking_paused_until", str(int(until)))],
        )
    finally:
        conn.close()


def _read_pause_state(db_path: str | Path) -> tuple[bool, float]:
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    try:
        rows = dict(
            conn.execute(
                "SELECT key, value FROM settings WHERE key IN"
                " ('tracking_paused','tracking_paused_until')"
            )
        )
    finally:
        conn.close()
    try:
        until = float(rows.get("tracking_paused_until", "0"))
    except ValueError:
        until = 0.0
    import time

    paused = rows.get("tracking_paused") == "1" or time.time() < until
    return paused, until


def _next_midnight() -> float:
    tomorrow = _dt.date.today() + _dt.timedelta(days=1)
    return _dt.datetime.combine(tomorrow, _dt.time.min).timestamp()


def start_tray(db_path: str | Path, stop_event: threading.Event) -> bool:
    """Start the tray icon in a daemon thread. Returns False when pystray or
    Pillow is unavailable (dev environments) — the tracker runs on regardless."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        logging.info("pystray/Pillow not installed; running without a tray icon.")
        return False

    def load_icon() -> "Image.Image":
        try:
            return Image.open(_icon_path())
        except Exception:
            # Fallback: the app's dark-clock look, minus the clock.
            img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            draw.ellipse((4, 4, 60, 60), fill=(22, 24, 29, 255), outline=(22, 185, 129, 255), width=6)
            return img

    import time as _time

    def status_text(_item) -> str:
        paused, until = _read_pause_state(db_path)
        if not paused:
            return "Recording"
        if until > _time.time():
            return f"Paused until {_dt.datetime.fromtimestamp(until):%H:%M}"
        return "Paused"

    def pause_for(seconds: float):
        def action(_icon, _item) -> None:
            _write_pause(db_path, "0", _time.time() + seconds)

        return action

    def pause_until_tomorrow(_icon, _item) -> None:
        _write_pause(db_path, "0", _next_midnight())

    def pause_indefinitely(_icon, _item) -> None:
        _write_pause(db_path, "1", 0)

    def resume(_icon, _item) -> None:
        _write_pause(db_path, "0", 0)

    def open_dashboard(_icon, _item) -> None:
        path = _dashboard_path()
        if path is None:
            return
        try:
            subprocess.Popen([str(path)], cwd=str(path.parent), close_fds=True)
        except OSError:
            logging.exception("Could not open the Time dashboard")

    def quit_tracker(icon, _item) -> None:
        stop_event.set()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem(status_text, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Pause tracking",
            pystray.Menu(
                pystray.MenuItem("For 15 minutes", pause_for(15 * 60)),
                pystray.MenuItem("For 1 hour", pause_for(60 * 60)),
                pystray.MenuItem("Until tomorrow", pause_until_tomorrow),
                pystray.MenuItem("Until resumed", pause_indefinitely),
            ),
        ),
        pystray.MenuItem("Resume tracking", resume),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Open dashboard",
            open_dashboard,
            visible=lambda _item: _dashboard_path() is not None,
        ),
        pystray.MenuItem("Quit tracker", quit_tracker),
    )
    icon = pystray.Icon("time-tracker", load_icon(), "Time tracker", menu)

    thread = threading.Thread(target=icon.run, name="tray", daemon=True)
    thread.start()
    return True
