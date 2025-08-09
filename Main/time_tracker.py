# time_tracker.py
# Minimal, fast, and robust tracker (no logging).

import ctypes
import sqlite3
import time
from pathlib import Path
from typing import Union

import config
import psutil
import win32gui
import win32process

# ---------- SQLite helpers ----------


def open_db(db_path: Union[str, Path]) -> sqlite3.Connection:
    """
    Open the database in WAL mode, bootstrap schema + indexes,
    and return the connection. Uses autocommit for durability and simplicity.
    """
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row

    # performance / durability
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")

    # schema
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS time_log (
            id INTEGER PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            process_name TEXT NOT NULL,
            window_title TEXT,
            poll_rate REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_time ON time_log (timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_proc ON time_log (process_name)")

    return conn


def log_time(conn: sqlite3.Connection, process_name: str, window_title: str, ts: float):
    conn.execute(
        """
        INSERT INTO time_log (timestamp, process_name, window_title, poll_rate)
        VALUES (?, ?, ?, ?)
        """,
        (int(ts), process_name, window_title, float(config.POLL_RATE_SECONDS)),
    )


# ---------- Win32: idle + active window ----------


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("dwTime", ctypes.c_uint),
    ]  # dwTime is 32-bit tick count (ms)


_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


def get_idle_duration() -> float:
    """
    Returns idle time in seconds, robust to the 32-bit tick wraparound of LASTINPUTINFO.dwTime.
    """
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not _user32.GetLastInputInfo(ctypes.byref(lii)):
        raise ctypes.WinError(ctypes.get_last_error())

    now64 = int(_kernel32.GetTickCount64())  # ms, 64-bit, no wrap
    last32 = int(lii.dwTime)  # ms, 32-bit, wraps ~49.7 days
    now32 = now64 & 0xFFFFFFFF

    # Compute diff in 32-bit space to handle wrap
    if now32 >= last32:
        diff_ms = now32 - last32
    else:
        diff_ms = (0x100000000 - last32) + now32

    return max(0.0, diff_ms / 1000.0)


def _get_active_hwnd():
    return win32gui.GetForegroundWindow()


def get_active_process_name() -> str | None:
    try:
        hwnd = _get_active_hwnd()
        if not hwnd:
            return None
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return psutil.Process(pid).name()
    except Exception:
        return None


def get_active_window_title(max_len: int = 512) -> str:
    try:
        hwnd = _get_active_hwnd()
        if not hwnd:
            return ""
        title = win32gui.GetWindowText(hwnd) or ""
        title = title.replace("\x00", "")  # sanitize NULs
        if len(title) > max_len:
            title = title[:max_len]
        return title
    except Exception:
        return ""


# ---------- main loop ----------


def run():
    poll = float(config.POLL_RATE_SECONDS)
    idle_thresh = float(config.IDLE_THRESHOLD_SECONDS)

    with open_db(config.DB_PATH) as conn:
        batch = 0
        next_tick = time.monotonic()

        try:
            while True:
                next_tick += poll

                if get_idle_duration() < idle_thresh:
                    pname = get_active_process_name()
                    if pname:
                        wtitle = get_active_window_title()
                        log_time(conn, pname, wtitle, time.time())
                        batch += 1
                        if batch >= 100:
                            # Keep WAL file from growing unbounded during long runs
                            conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                            batch = 0

                # drift-free sleep
                sleep_for = max(0.0, next_tick - time.monotonic())
                time.sleep(sleep_for)

        except KeyboardInterrupt:
            # graceful exit
            pass


if __name__ == "__main__":
    run()
