"""Bootstrap-only configuration: values that cannot live in the DB settings table."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DB_PATH = ROOT / "Data" / "time_log.db"
LOG_PATH = ROOT / "Logs" / "tracker.log"

POLL_SECONDS = 1.0  # transition-detection cadence; not a tunable, accuracy depends on it
