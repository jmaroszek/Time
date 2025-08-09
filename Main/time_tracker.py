import ctypes
import logging
import sqlite3
import time
from logging.handlers import TimedRotatingFileHandler

import config
import psutil
import win32gui
import win32process


def set_up_logging():
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)

    handler = TimedRotatingFileHandler(
        filename=config.LOG_PATH, when="midnight", backupCount=1
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

    while True:
        if get_idle_duration() >= config.IDLE_THRESHOLD_SECONDS:
            logging.warning("AFK")
        else:
            process_name = get_active_process_name()
            window_title = get_active_window_title()
            current_time = time.time()
            if process_name:
                log_time(process_name, window_title, current_time)
                logging.info(f"{process_name} | {window_title}")
            else:
                logging.info("No process found.")

        time.sleep(config.POLL_RATE_SECONDS)
