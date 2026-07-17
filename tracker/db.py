"""Schema bootstrap, seed data, settings access, and the sqlite-backed Store.

All DDL is idempotent (CREATE IF NOT EXISTS); seeds only run into empty tables,
so opening the DB from the tracker, the migration script, or tests is always
safe. The legacy `time_log` table is left completely untouched.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Callable, TypeVar

from tracker.session_manager import Settings

T = TypeVar("T")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts   INTEGER NOT NULL,
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
    priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""

# (name, color, is_productive, is_neutral, sort_order). Productivity is a
# three-way state: productive (1,0), neutral (0,1), or unproductive (0,0).
# Gaming is neutral by default — tracked, but never held against productivity.
_SEED_CATEGORIES = [
    ("Notes", "#7f77dd", 1, 0, 1),
    ("Dev", "#3f9bf0", 1, 0, 2),
    ("AI tools", "#43c88a", 1, 0, 3),
    ("Browsing", "#e0a53a", 1, 0, 4),
    ("Gaming", "#e8663d", 0, 1, 5),
    ("Media", "#e75fa0", 0, 0, 6),
    ("System", "#828994", 0, 0, 7),
]

# Priorities: domain (1) > title (2) > process (3). Lower numbers win.
# are only evaluated for browser sessions by the dashboard classifier; process
# rules apply everywhere.
_SEED_RULES = [
    ("process", "obsidian.exe", "Notes", 3),
    ("process", "code.exe", "Dev", 3),
    ("process", "windowsterminal.exe", "Dev", 3),
    ("process", "antigravity.exe", "Dev", 3),
    ("process", "python.exe", "Dev", 3),
    ("process", "db browser for sqlite.exe", "Dev", 3),
    ("process", "claude.exe", "AI tools", 3),
    ("process", "codex.exe", "AI tools", 3),
    ("process", "chrome.exe", "Browsing", 3),
    ("process", "thorium.exe", "Browsing", 3),
    ("process", "sumatrapdf.exe", "Notes", 3),
    ("process", "excel.exe", "Dev", 3),
    ("process", "notepad.exe", "Notes", 3),
    ("process", "r5apex_dx12.exe", "Gaming", 3),
    ("process", "rocketleague.exe", "Gaming", 3),
    ("process", "b1-win64-shipping.exe", "Gaming", 3),
    ("process", "u4.exe", "Gaming", 3),
    ("process", "steam.exe", "Gaming", 3),
    ("process", "steamwebhelper.exe", "Gaming", 3),
    ("process", "explorer.exe", "System", 3),
    ("process", "searchhost.exe", "System", 3),
    ("process", "lockapp.exe", "System", 3),
    ("process", "shellexperiencehost.exe", "System", 3),
    ("process", "applicationframehost.exe", "System", 3),
    ("domain", "docs.google.com", "Notes", 1),
    ("domain", "drive.google.com", "Notes", 1),
    ("domain", "youtube.com", "Media", 1),
    ("domain", "reddit.com", "Media", 1),
    ("domain", "netflix.com", "Media", 1),
    ("domain", "twitch.tv", "Media", 1),
    ("title", "youtube", "Media", 2),
    ("title", "reddit", "Media", 2),
    ("title", "netflix", "Media", 2),
    ("title", "twitch", "Media", 2),
]

DEFAULT_SETTINGS = {
    "weekly_goal_hours": "20",
    "idle_threshold_seconds": "180",
    "heartbeat_seconds": "15",
    "week_start": "Sunday",
    "default_top_n_apps": "5",
    "browser_processes": "chrome.exe,thorium.exe",
    "min_app_seconds": "300",
    "focus_chain_max_gap_seconds": "120",
    "day_start_hour": "0",
    "day_end_hour": "24",
}


def open_db(db_path: str | Path) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.executescript(_SCHEMA)
    _seed(conn)
    _migrate_rule_priorities(conn)
    return conn


def _migrate_rule_priorities(conn: sqlite3.Connection) -> None:
    """One-time conversion from high-wins priorities to compact low-wins ranks."""
    marker = conn.execute(
        "SELECT value FROM settings WHERE key='rule_priority_scheme'"
    ).fetchone()
    if marker and marker[0] == "low-wins-v1":
        return
    values = [row[0] for row in conn.execute(
        "SELECT DISTINCT priority FROM rules ORDER BY priority DESC"
    )]
    # Fresh databases already use the compact scheme. Existing databases from
    # the earlier release have 100/200/300 (or custom values on that scale).
    if values and all(1 <= value <= 3 for value in values):
        conn.execute(
            "INSERT INTO settings (key,value) VALUES ('rule_priority_scheme','low-wins-v1')"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        return
    for rank, old in enumerate(values, start=1):
        conn.execute("UPDATE rules SET priority=? WHERE priority=?", (-rank, old))
    conn.execute("UPDATE rules SET priority=-priority WHERE priority < 0")
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('rule_priority_scheme','low-wins-v1')"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )


def _seed(conn: sqlite3.Connection) -> None:
    # Older DBs predate the is_ignored / is_neutral columns; add them in place.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(categories)")}
    if "is_ignored" not in cols:
        conn.execute(
            "ALTER TABLE categories ADD COLUMN is_ignored INTEGER NOT NULL DEFAULT 0"
        )
    if "is_neutral" not in cols:
        conn.execute(
            "ALTER TABLE categories ADD COLUMN is_neutral INTEGER NOT NULL DEFAULT 0"
        )

    if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO categories (name, color, is_productive, is_neutral, sort_order)"
            " VALUES (?,?,?,?,?)",
            _SEED_CATEGORIES,
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
    # The Ignored bucket is seeded even into existing DBs: sessions classified
    # here are hidden from every visualization (managed in the Apps tab).
    conn.execute(
        "INSERT OR IGNORE INTO categories (name, color, is_productive, is_ignored, sort_order)"
        " VALUES ('Ignored', '#44474e', 0, 1, 99)"
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
    )


def _retry(fn: Callable[[], T], attempts: int = 5, base_delay: float = 0.1) -> T:
    for i in range(attempts):
        try:
            return fn()
        except sqlite3.OperationalError:
            if i == attempts - 1:
                raise
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

        session_id = _retry(_do)
        logging.info("OPEN  %s | %s", process, title[:120])
        return session_id

    def close_session(self, session_id: int, end_ts: float) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            )
        )
        logging.info("CLOSE #%s @ %s", session_id, int(end_ts))

    def heartbeat(self, session_id: int, end_ts: float) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            )
        )
