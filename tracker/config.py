"""Bootstrap-only configuration: values that cannot live in the DB settings table."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _data_dir() -> Path:
    """Per-user data directory shared with the dashboard.

    Both halves independently resolve the same %LOCALAPPDATA%\\Time location so
    the SQLite database is a stable contract regardless of where the code lives.
    Override with TIME_DATA_DIR (tests, or pointing at an alternate DB). The
    repo-relative fallback only applies off Windows / when LOCALAPPDATA is unset.
    """
    override = os.environ.get("TIME_DATA_DIR")
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "Time"
    return ROOT / "Data"


DATA_DIR = _data_dir()
DB_PATH = DATA_DIR / "time_log.db"
LOG_PATH = DATA_DIR / "Logs" / "tracker.log"

# Written to the settings table at startup (DIST-005); bump with releases.
TRACKER_VERSION = "0.1.0"

POLL_SECONDS = 1.0  # transition-detection cadence; not a tunable, accuracy depends on it
