"""Bootstrap-only configuration: values that cannot live in the DB settings table."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _data_dir() -> Path:
    """Per-user data directory shared with the dashboard.

    Both halves independently resolve the same %LOCALAPPDATA%\\Time\\Data
    location so the SQLite database is a stable contract regardless of where the
    code lives. Everything the user owns — database, write-ahead log, logs,
    backups — lives under this one directory, which keeps it distinct from the
    installation beside it. Override with TIME_DATA_DIR (tests, or pointing at
    an alternate DB). The repo-relative fallback only applies off Windows / when
    LOCALAPPDATA is unset.
    """
    override = None if getattr(sys, "frozen", False) else os.environ.get("TIME_DATA_DIR")
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "Time" / "Data"
    return ROOT / "Data"


DATA_DIR = _data_dir()
DB_PATH = DATA_DIR / "database.db"
LOG_PATH = DATA_DIR / "Logs" / "tracker.log"

# Written to the settings table at startup so the dashboard can report it; bump
# with releases.
TRACKER_VERSION = "0.1.0"

# The production mutex name is stable. The override exists so release packaging
# can be smoke-tested against a scratch DB while the live tracker keeps running,
# which means the packaged build is the one case that has to honour it: gating
# the override on `frozen` exempted exactly that build, and a smoke run would
# have found the live tracker's mutex, logged "already running" and exited 0 —
# a pass that recorded nothing.
MUTEX_NAME = os.environ.get("TIME_MUTEX_NAME", "Global\\TimeTrackerSingleton")

POLL_SECONDS = 1.0  # transition-detection cadence; not a tunable, accuracy depends on it
