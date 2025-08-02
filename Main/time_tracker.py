import ctypes
import logging
import math
import sqlite3
import time
from logging.handlers import TimedRotatingFileHandler

import config
import psutil
import win32api
import win32gui
import win32process
from config import IDLE_THRESHOLD_SECONDS, MOUSE_MOVE_THRESHOLD


def set_up_logging():
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)

    handler = TimedRotatingFileHandler(
        filename=config.LOG_PATH, when="midnight", backupCount=1, encoding="utf-8"
    )

    formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    handler.setFormatter(formatter)

    if logger.hasHandlers():
        logger.handlers.clear()
    else:
        logger.addHandler(handler)


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("dwTime", ctypes.c_uint),
    ]


def create_database():
    """
    Create the SQLite database and time_log table if they do not exist.
    """
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "PRAGMA journal_mode=WAL;"
    )  # Write ahead logging for better performance
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS time_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            process_name TEXT,
            window_title TEXT,
            poll_rate REAL NOT NULL DEFAULT 5       
        );
    """)
    conn.commit()
    conn.close()


def log_time(process_name, window_title, timestamp):
    """
    Inserts a record into the time_log table.
    """
    conn = sqlite3.connect(config.DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO time_log (timestamp, process_name, window_title, poll_rate)
        VALUES (?, ?, ?, ?)
    """,
        (timestamp, process_name, window_title, config.POLL_RATE_SECONDS),
    )
    conn.commit()
    conn.close()


def get_idle_duration():
    """
    Returns the idle time in seconds by comparing the current tick count with the last input time.
    """
    last_input_info = LASTINPUTINFO()
    last_input_info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if ctypes.windll.user32.GetLastInputInfo(ctypes.byref(last_input_info)):
        # GetTickCount returns milliseconds since the system started; dwTime is in ms.
        millis_since_last_input = (
            ctypes.windll.kernel32.GetTickCount() - last_input_info.dwTime
        )
        return millis_since_last_input / 1000.0  # Convert to seconds
    else:
        return 0


def update_activity_state(last_mouse_pos, last_sys_input_time, last_valid_input_time):
    """
    Check raw system input and apply a movement threshold to filter out jitter.
    Returns updated (last_mouse_pos, last_sys_input_time, last_valid_input_time).
    """
    now = time.time()
    idle = get_idle_duration()  # milliseconds→seconds internally handled
    sys_input_ts = now - idle

    # Only process once per system input event
    if sys_input_ts > last_sys_input_time:
        curr_pos = win32api.GetCursorPos()
        dx = curr_pos[0] - last_mouse_pos[0]
        dy = curr_pos[1] - last_mouse_pos[1]
        dist = math.hypot(dx, dy)

        if dist >= MOUSE_MOVE_THRESHOLD:
            # real mouse move
            last_valid_input_time = now
            last_mouse_pos = curr_pos
        elif dx == 0 and dy == 0:
            # keyboard input
            last_valid_input_time = now
        # small jitter → ignore

        last_sys_input_time = sys_input_ts

    return last_mouse_pos, last_sys_input_time, last_valid_input_time


def get_active_window_title():
    """
    Retrieves the title of the currently active window.
    """
    window_handle = win32gui.GetForegroundWindow()
    if window_handle:
        return win32gui.GetWindowText(window_handle)
    return None


def get_active_process_name():
    """
    Retrieves the process name of the currently active window.
    """
    window_handle = win32gui.GetForegroundWindow()
    if window_handle:
        try:
            _, pid = win32process.GetWindowThreadProcessId(window_handle)
            process = psutil.Process(pid)
            return process.name()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            return None
    return None


if __name__ == "__main__":
    set_up_logging()
    create_database()

    # initialize AFK-sensor state
    last_mouse_pos = win32api.GetCursorPos()
    last_sys_input_time = time.time() - get_idle_duration()
    last_valid_input_time = time.time()

    while True:
        now = time.time()
        # update our “last valid input” using the threshold logic
        (last_mouse_pos, last_sys_input_time, last_valid_input_time) = (
            update_activity_state(
                last_mouse_pos, last_sys_input_time, last_valid_input_time
            )
        )

        # decide AFK vs. active
        if now - last_valid_input_time >= IDLE_THRESHOLD_SECONDS:
            logging.warning("AFK")
        else:
            proc = get_active_process_name()
            title = get_active_window_title()
            if proc:
                log_time(proc, title, now)
                logging.info(f"{proc} | {title}")
            else:
                logging.info("No process found.")

        time.sleep(config.POLL_RATE_SECONDS)
