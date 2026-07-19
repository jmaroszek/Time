"""Schema bootstrap, versioned migrations, settings, and sqlite-backed storage.

The tracker is the sole DDL/migration owner. The legacy `time_log` table is
left completely untouched.
"""

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
"""

_CATEGORY_DELETE_TRIGGER = """
CREATE TRIGGER IF NOT EXISTS delete_category_rules
BEFORE DELETE ON categories
FOR EACH ROW
BEGIN
    DELETE FROM rules WHERE category_id = OLD.id;
END
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
    # Pause state (written by the tray / dashboard, read by the tracker):
    # tracking_paused = "1" pauses until resumed; tracking_paused_until = unix
    # seconds pauses until that moment (self-resuming).
    "tracking_paused": "0",
    "tracking_paused_until": "0",
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
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    try:
        version = _read_schema_version(conn)
        if version > SCHEMA_VERSION:
            raise SchemaTooNewError(
                f"database schema {version} is newer than tracker schema"
                f" {SCHEMA_VERSION}; update Time before tracking"
            )
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.executescript(_SCHEMA)
        _migrate_rule_priorities(conn)
        _run_migrations(conn, version)
        _seed(conn)
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


def _run_migrations(conn: sqlite3.Connection, version: int) -> None:
    while version < SCHEMA_VERSION:
        if version == 0:
            _migrate_v0_to_v1(conn)
            version = 1
            continue
        raise RuntimeError(f"no migration path from schema version {version}")


def _migrate_v0_to_v1(conn: sqlite3.Connection) -> None:
    """Atomically add row/rule constraints and remove invalid legacy data."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        _ensure_legacy_columns(conn)
        conn.execute(
            "CREATE TABLE sessions_v1 ("
            " id INTEGER PRIMARY KEY, start_ts INTEGER NOT NULL,"
            " end_ts INTEGER NOT NULL CHECK(end_ts >= start_ts),"
            " process TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', domain TEXT,"
            " is_afk INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'live')"
        )
        # Zero/negative legacy rows have never contributed to dashboard totals.
        conn.execute(
            "INSERT INTO sessions_v1"
            " (id,start_ts,end_ts,process,title,domain,is_afk,source)"
            " SELECT id,start_ts,end_ts,process,title,domain,is_afk,source"
            " FROM sessions WHERE end_ts > start_ts"
        )

        conn.execute(
            "CREATE TABLE rules_v1 ("
            " id INTEGER PRIMARY KEY,"
            " match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),"
            " pattern TEXT NOT NULL,"
            " category_id INTEGER NOT NULL REFERENCES categories(id),"
            " priority INTEGER NOT NULL DEFAULT 0,"
            " UNIQUE(match_type, pattern))"
        )
        # Existing tie semantics are first-added-wins, so retain the lowest id.
        conn.execute(
            "INSERT INTO rules_v1 (id,match_type,pattern,category_id,priority)"
            " SELECT r.id,r.match_type,r.pattern,r.category_id,r.priority FROM rules r"
            " WHERE r.id = (SELECT MIN(r2.id) FROM rules r2"
            " WHERE r2.match_type=r.match_type AND r2.pattern=r.pattern)"
        )

        conn.execute("DROP TABLE sessions")
        conn.execute("ALTER TABLE sessions_v1 RENAME TO sessions")
        conn.execute("CREATE INDEX idx_sessions_start ON sessions(start_ts)")
        conn.execute("CREATE INDEX idx_sessions_proc ON sessions(process)")
        conn.execute("DROP TABLE rules")
        conn.execute("ALTER TABLE rules_v1 RENAME TO rules")
        conn.execute(_CATEGORY_DELETE_TRIGGER)
        conn.execute(
            "INSERT INTO settings (key,value) VALUES ('schema_version',?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION),),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def _migrate_rule_priorities(conn: sqlite3.Connection) -> None:
    """Restart-safe conversion from high-wins priorities to low-wins ranks."""
    for _ in range(5):
        marker = conn.execute(
            "SELECT value FROM settings WHERE key='rule_priority_scheme'"
        ).fetchone()
        state = marker[0] if marker else None
        if state == "low-wins-v1":
            return

        if state is None:
            values = [row[0] for row in conn.execute(
                "SELECT DISTINCT priority FROM rules ORDER BY priority"
            )]
            already_compact = not values or all(1 <= value <= 3 for value in values)
            conn.execute(
                "INSERT OR IGNORE INTO settings (key,value) VALUES"
                " ('rule_priority_scheme',?)",
                ("low-wins-v1" if already_compact else "ranking-v1",),
            )
            continue

        if state == "ranking-v1":
            conn.execute(
                "WITH ranked AS ("
                " SELECT priority, ROW_NUMBER() OVER (ORDER BY priority DESC) AS rank"
                " FROM (SELECT DISTINCT priority FROM rules WHERE priority > 0)"
                ") UPDATE rules SET priority = -(SELECT rank FROM ranked"
                " WHERE ranked.priority = rules.priority) WHERE priority > 0"
            )
            conn.execute(
                "UPDATE settings SET value='ranked-v1'"
                " WHERE key='rule_priority_scheme' AND value='ranking-v1'"
            )
            continue

        if state == "ranked-v1":
            conn.execute("UPDATE rules SET priority=-priority WHERE priority < 0")
            conn.execute(
                "UPDATE settings SET value='low-wins-v1'"
                " WHERE key='rule_priority_scheme' AND value='ranked-v1'"
            )
            continue

        conn.execute(
            "UPDATE settings SET value='ranking-v1' WHERE key='rule_priority_scheme'"
        )
    raise RuntimeError("rule priority migration did not converge")


def _ensure_legacy_columns(conn: sqlite3.Connection) -> None:
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


def _seed(conn: sqlite3.Connection) -> None:
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
        tracking_paused=is_paused(raw),
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
        # DEBUG, not INFO: window titles are sensitive, and an INFO-level log
        # would archive them in plain text alongside the DB (audit DIST-003).
        logging.debug("OPEN  %s | %s", process, title[:120])
        return session_id

    def close_session(self, session_id: int, end_ts: float) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            )
        )
        logging.debug("CLOSE #%s @ %s", session_id, int(end_ts))

    def heartbeat(self, session_id: int, end_ts: float) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            )
        )
