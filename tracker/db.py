"""Current schema bootstrap, settings, and SQLite-backed session storage."""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Callable, TypeVar

from tracker.session_manager import Settings

T = TypeVar("T")
SCHEMA_VERSION = 1


class SchemaTooNewError(RuntimeError):
    """Raised before writes when an older tracker sees a newer database."""

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts   INTEGER NOT NULL CHECK(end_ts >= start_ts),
    process  TEXT NOT NULL,
    title    TEXT NOT NULL DEFAULT '',
    domain   TEXT,
    is_afk   INTEGER NOT NULL DEFAULT 0,
    source   TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_ts);
CREATE INDEX IF NOT EXISTS idx_sessions_proc  ON sessions(process);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    is_productive INTEGER NOT NULL DEFAULT 0,
    is_neutral INTEGER NOT NULL DEFAULT 0,
    is_ignored INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY,
    match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),
    pattern TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    priority INTEGER NOT NULL DEFAULT 0,
    UNIQUE(match_type, pattern)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TRIGGER IF NOT EXISTS delete_category_rules
BEFORE DELETE ON categories
FOR EACH ROW
BEGIN
    DELETE FROM rules WHERE category_id = OLD.id;
END
"""

# A small, broadly applicable starter taxonomy reduces first-run setup without
# guessing which applications or sites serve those purposes. Every category is
# editable/deletable except the functional Ignored row; no rules are preloaded.
_SEED_CATEGORIES = [
    ("Focus", "#2f6fc0", 1, 0, 1),
    ("Learning", "#9c8ff0", 1, 0, 2),
    ("Communication", "#56c8d8", 0, 1, 3),
    ("Entertainment", "#e8663d", 0, 0, 4),
    ("Utilities", "#828994", 0, 1, 5),
    ("Ignored", "#44474e", 0, 0, 99),
]

# Deliberately empty: Time ships with no opinion about which apps or sites are
# productive. The shape stays here because the priority contract has to hold for
# any rule that is added later — lower number wins: domain (1), title (2),
# process (3). Domain and title rules are evaluated only for browser sessions;
# process rules apply everywhere.
_SEED_RULES: list[tuple[str, str, str, int]] = []

DEFAULT_SETTINGS = {
    "weekly_goal_hours": "0",
    "idle_threshold_seconds": "180",
    "heartbeat_seconds": "15",
    "week_start": "auto",
    "default_top_n_apps": "5",
    "browser_processes": "chrome.exe,msedge.exe,firefox.exe,brave.exe",
    "min_app_seconds": "0",
    "focus_chain_max_gap_seconds": "120",
    "day_start_hour": "0",
    "day_end_hour": "24",
    # Pause state (written by the tray / dashboard, read by the tracker):
    # tracking_paused = "1" pauses until resumed; tracking_paused_until = unix
    # seconds pauses until that moment (self-resuming).
    "tracking_paused": "0",
    "tracking_paused_until": "0",
    # Tracking requires an explicit first-run choice. Window titles are a
    # separate opt-in because they can contain document names or message text.
    "recording_consent": "0",
    "record_window_titles": "0",
    "privacy_onboarding_complete": "0",
    "launch_at_login": "0",
}


def is_paused(raw: dict[str, str], now: float | None = None) -> bool:
    """True when tracking is paused, either indefinitely or until a future time."""
    if raw.get("tracking_paused") == "1":
        return True
    try:
        until = float(raw.get("tracking_paused_until", "0"))
    except (TypeError, ValueError):
        return False
    return (now if now is not None else time.time()) < until


def open_db(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    existed = path.is_file() and path.stat().st_size > 0
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    try:
        version = _read_schema_version(conn)
        if version > SCHEMA_VERSION:
            raise SchemaTooNewError(
                f"database schema {version} is newer than tracker schema"
                f" {SCHEMA_VERSION}; update Time before tracking"
            )
        if existed and version == 0:
            user_tables = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master"
                " WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchone()[0]
            if user_tables:
                raise RuntimeError(
                    "unversioned pre-release database; migrate it before running this release"
                )
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA secure_delete=ON;")
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.executescript("BEGIN IMMEDIATE;\n" + _SCHEMA)
        try:
            _seed(conn)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return conn
    except Exception:
        conn.close()
        raise


def _read_schema_version(conn: sqlite3.Connection) -> int:
    settings_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'"
    ).fetchone()
    if settings_exists is None:
        return 0
    row = conn.execute(
        "SELECT value FROM settings WHERE key='schema_version'"
    ).fetchone()
    if row is None:
        return 0
    try:
        version = int(row[0])
    except (TypeError, ValueError) as exc:
        raise RuntimeError("database schema_version is not a valid integer") from exc
    if version < 0:
        raise RuntimeError("database schema_version cannot be negative")
    return version


def _seed(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO categories (name, color, is_productive, is_neutral, sort_order)"
            " VALUES (?,?,?,?,?)",
            _SEED_CATEGORIES,
        )
        conn.execute(
            "INSERT OR IGNORE INTO settings (key,value)"
            " VALUES ('starter_categories_pending','1')"
        )
    if conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 0:
        cat_ids = {
            row["name"]: row["id"]
            for row in conn.execute("SELECT id, name FROM categories")
        }
        conn.executemany(
            "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES (?,?,?,?)",
            [
                (mt, pat, cat_ids[cat], prio)
                for mt, pat, cat, prio in _SEED_RULES
                if cat in cat_ids
            ],
        )
    conn.execute(
        "UPDATE categories SET is_ignored=1 WHERE name='Ignored'"
    )
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('schema_version',?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    conn.execute(
        "INSERT OR IGNORE INTO settings (key,value) VALUES"
        " ('rule_priority_scheme','low-wins-v1')"
    )
    conn.executemany(
        "INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)",
        list(DEFAULT_SETTINGS.items()),
    )


def read_settings_raw(conn: sqlite3.Connection) -> dict[str, str]:
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM settings")}


def get_settings(conn: sqlite3.Connection) -> Settings:
    """Tracker-relevant settings, parsed and validated with safe fallbacks."""
    raw = read_settings_raw(conn)

    def _float(key: str, default: float, lo: float, hi: float) -> float:
        try:
            val = float(raw.get(key, default))
        except (TypeError, ValueError):
            return default
        return min(max(val, lo), hi)

    browsers = frozenset(
        p.strip().lower()
        for p in raw.get("browser_processes", DEFAULT_SETTINGS["browser_processes"]).split(",")
        if p.strip()
    )
    return Settings(
        idle_threshold_seconds=_float("idle_threshold_seconds", 180.0, 30.0, 3600.0),
        heartbeat_seconds=_float("heartbeat_seconds", 15.0, 5.0, 300.0),
        browser_processes=browsers or frozenset({"chrome.exe"}),
        tracking_paused=is_paused(raw),
        recording_consent=raw.get("recording_consent") == "1",
        record_window_titles=raw.get("record_window_titles") == "1",
    )


def _retry(
    fn: Callable[[], T],
    attempts: int = 5,
    base_delay: float = 0.1,
    op: str = "write",
) -> T:
    """Retry a write past transient lock contention, with backoff.

    Retries and exhaustion are logged because a lost session is otherwise
    invisible in the field. `op` is a fixed operation name and the SQLite error
    text describes the lock, so neither carries session content into the log.
    """
    for i in range(attempts):
        try:
            return fn()
        except sqlite3.OperationalError as exc:
            if i == attempts - 1:
                logging.error(
                    "SQLite %s failed after %d attempts over ~%.1fs; data was lost: %s",
                    op,
                    attempts,
                    base_delay * (2 ** (attempts - 1) - 1),
                    exc,
                )
                raise
            logging.warning(
                "SQLite %s retry %d of %d: %s", op, i + 1, attempts - 1, exc
            )
            time.sleep(base_delay * (2**i))
    raise RuntimeError("unreachable")


class SqliteStore:
    """Store implementation used by the live tracker. Logs transitions."""

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def open_session(
        self, start_ts: float, process: str, title: str, domain: str | None, is_afk: bool
    ) -> int:
        def _do() -> int:
            cur = self._conn.execute(
                "INSERT INTO sessions (start_ts, end_ts, process, title, domain, is_afk, source)"
                " VALUES (?,?,?,?,?,?,'live')",
                (int(start_ts), int(start_ts), process, title[:512], domain, int(is_afk)),
            )
            return int(cur.lastrowid)

        session_id = _retry(_do, op="open_session")
        # DEBUG, not INFO: window titles are sensitive, and an INFO-level log
        # would archive them in plain text alongside the database.
        logging.debug("OPEN  %s | %s", process, title[:120])
        return session_id

    def close_session(self, session_id: int, end_ts: float) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            ),
            op="close_session",
        )
        logging.debug("CLOSE #%s @ %s", session_id, int(end_ts))

    def heartbeat(self, session_id: int, end_ts: float) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            ),
            op="heartbeat",
        )
