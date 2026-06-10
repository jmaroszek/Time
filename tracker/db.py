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

# (name, color, is_productive, sort_order)
_SEED_CATEGORIES = [
    ("Notes", "#7F77DD", 1, 1),
    ("Dev", "#378ADD", 1, 2),
    ("AI tools", "#1D9E75", 1, 3),
    ("Browsing", "#EF9F27", 1, 4),
    ("Gaming", "#D85A30", 0, 5),
    ("Media", "#D4537E", 0, 6),
    ("System", "#888780", 0, 7),
]

# Priorities: domain (300) > title (200) > process (100). Domain and title rules
# are only evaluated for browser sessions by the dashboard classifier; process
# rules apply everywhere.
_SEED_RULES = [
    ("process", "obsidian.exe", "Notes", 100),
    ("process", "code.exe", "Dev", 100),
    ("process", "windowsterminal.exe", "Dev", 100),
    ("process", "antigravity.exe", "Dev", 100),
    ("process", "python.exe", "Dev", 100),
    ("process", "db browser for sqlite.exe", "Dev", 100),
    ("process", "claude.exe", "AI tools", 100),
    ("process", "codex.exe", "AI tools", 100),
    ("process", "chrome.exe", "Browsing", 100),
    ("process", "thorium.exe", "Browsing", 100),
    ("process", "sumatrapdf.exe", "Notes", 100),
    ("process", "excel.exe", "Dev", 100),
    ("process", "notepad.exe", "Notes", 100),
    ("process", "r5apex_dx12.exe", "Gaming", 100),
    ("process", "rocketleague.exe", "Gaming", 100),
    ("process", "b1-win64-shipping.exe", "Gaming", 100),
    ("process", "u4.exe", "Gaming", 100),
    ("process", "steam.exe", "Gaming", 100),
    ("process", "steamwebhelper.exe", "Gaming", 100),
    ("process", "explorer.exe", "System", 100),
    ("process", "searchhost.exe", "System", 100),
    ("process", "lockapp.exe", "System", 100),
    ("process", "shellexperiencehost.exe", "System", 100),
    ("process", "applicationframehost.exe", "System", 100),
    ("domain", "docs.google.com", "Notes", 300),
    ("domain", "drive.google.com", "Notes", 300),
    ("domain", "youtube.com", "Media", 300),
    ("domain", "reddit.com", "Media", 300),
    ("domain", "netflix.com", "Media", 300),
    ("domain", "twitch.tv", "Media", 300),
    ("title", "youtube", "Media", 200),
    ("title", "reddit", "Media", 200),
    ("title", "netflix", "Media", 200),
    ("title", "twitch", "Media", 200),
]

DEFAULT_SETTINGS = {
    "weekly_goal_hours": "20",
    "idle_threshold_seconds": "180",
    "heartbeat_seconds": "15",
    "week_start": "Sunday",
    "default_top_n_apps": "5",
    "browser_processes": "chrome.exe,thorium.exe",
}


def open_db(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.executescript(_SCHEMA)
    _seed(conn)
    return conn


def _seed(conn: sqlite3.Connection) -> None:
    # Older DBs predate the is_ignored column; add it in place.
    cols = {row[1] for row in conn.execute("PRAGMA table_info(categories)")}
    if "is_ignored" not in cols:
        conn.execute(
            "ALTER TABLE categories ADD COLUMN is_ignored INTEGER NOT NULL DEFAULT 0"
        )

    if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO categories (name, color, is_productive, sort_order) VALUES (?,?,?,?)",
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
