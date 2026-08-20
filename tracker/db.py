"""Current schema bootstrap, settings, and SQLite-backed session storage."""

from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Callable, TypeVar

from tracker.domains import normalize_host
from tracker.session_manager import Settings
from tracker.tracking_schedule import (
    DEFAULT_DAYS,
    DEFAULT_END_MINUTE,
    DEFAULT_START_MINUTE,
    schedule_state,
)

T = TypeVar("T")
SCHEMA_VERSION = 4


class SchemaTooNewError(RuntimeError):
    """Raised before writes when an older tracker sees a newer database."""

_DELETE_CATEGORY_RULES_TRIGGER = """
CREATE TRIGGER IF NOT EXISTS delete_category_rules
BEFORE DELETE ON categories
FOR EACH ROW
BEGIN
    DELETE FROM rules WHERE category_id = OLD.id;
END;
"""

_SCHEMA = f"""
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
    -- Window rules need two independent claims: what part of a normalized
    -- title matches, and where that claim is allowed to apply. Empty strings
    -- keep the extra fields impossible on App/Website rules and make UNIQUE
    -- deterministic (SQLite treats NULLs as distinct).
    scope_kind TEXT NOT NULL DEFAULT ''
        CHECK(scope_kind IN ('','any','browsers','process','domain')),
    scope_value TEXT NOT NULL DEFAULT '',
    title_match_mode TEXT NOT NULL DEFAULT ''
        CHECK(title_match_mode IN ('','segment','phrase','contains')),
    title_anchor TEXT NOT NULL DEFAULT ''
        CHECK(title_anchor IN ('','any','first','interior','last')),
    CHECK (
        (
            match_type = 'title'
            AND scope_kind IN ('any','browsers','process','domain')
            AND title_match_mode IN ('segment','phrase','contains')
            AND title_anchor IN ('any','first','interior','last')
            AND (title_match_mode = 'segment' OR title_anchor = 'any')
            AND (
                (scope_kind IN ('any','browsers') AND scope_value = '')
                OR (scope_kind IN ('process','domain') AND length(scope_value) > 0)
            )
        )
        OR
        (
            match_type <> 'title'
            AND scope_kind = ''
            AND scope_value = ''
            AND title_match_mode = ''
            AND title_anchor = ''
        )
    ),
    UNIQUE(
        match_type, pattern, scope_kind, scope_value,
        title_match_mode, title_anchor
    )
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
{_DELETE_CATEGORY_RULES_TRIGGER}

CREATE TABLE IF NOT EXISTS tracking_exclusions (
    kind       TEXT NOT NULL CHECK(kind IN ('app','website')),
    pattern    TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    PRIMARY KEY(kind, pattern)
);

CREATE TABLE IF NOT EXISTS session_corrections (
    session_id         INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    corrected_start_ts INTEGER,
    corrected_end_ts   INTEGER,
    category_id        INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    updated_ts         INTEGER NOT NULL,
    CHECK (
        (corrected_start_ts IS NULL AND corrected_end_ts IS NULL)
        OR
        (corrected_start_ts IS NOT NULL AND corrected_end_ts IS NOT NULL
         AND corrected_end_ts > corrected_start_ts)
    )
);
CREATE INDEX IF NOT EXISTS idx_session_corrections_category
    ON session_corrections(category_id);
CREATE TRIGGER IF NOT EXISTS cleanup_empty_session_corrections
AFTER DELETE ON categories
FOR EACH ROW
BEGIN
    DELETE FROM session_corrections
    WHERE corrected_start_ts IS NULL AND corrected_end_ts IS NULL AND category_id IS NULL;
END;
"""

# A small, broadly applicable starter taxonomy reduces first-run setup without
# guessing which applications or sites serve those purposes. Every category is
# editable/deletable except the functional Ignored row; no rules are preloaded.
#
# Every name here describes a kind of *application*, never a kind of intent. That
# is what lets anything but the user populate one: an executable can say it is a
# mail client, but nothing about it says whether reading mail was focus or
# avoidance. The productivity flags carry that judgment, and the user owns them.
# An earlier set mixed the two — "Focus" and "Learning" beside "Communication" —
# which left one productive destination that had to absorb editors, spreadsheets,
# design tools and note apps alike, describing none of them.
#
# "Focus" also already means something computed in the dashboard: the Longest
# focus KPI and the focus-chain gap setting measure the longest run of productive
# time, which is not the same hours as any one category.
#
# Browsing exists because browser time is the largest single block of a typical
# day and the one thing Time must never classify on the user's behalf — domains
# are only visible when a URL-title extension is installed, so a browser rule
# would swallow the rest. A neutral home the user can accept keeps that time
# honest, and Website rules (priority 1) still outrank the App rule (priority 3)
# later.
#
# Colors come from the dashboard's category swatch list and must stay out of the
# hue arcs productivity reserves (green ~150-165deg, red-orange ~10-25deg), or a
# category renders in charts with the hue that means productive/unproductive.
_SEED_CATEGORIES = [
    ("Work", "#2f6fc0", 1, 0, 1),
    ("Communication", "#56c8d8", 0, 1, 2),
    ("Browsing", "#e0a53a", 0, 1, 3),
    ("Entertainment", "#e75fa0", 0, 0, 4),
    ("System", "#828994", 0, 1, 5),
    ("Ignored", "#44474e", 0, 0, 99),
]

# Deliberately empty: Time ships with no opinion about which apps or sites are
# productive. The shape stays here because the priority contract has to hold for
# any rule that is added later — lower number wins: domain-scoped title (0),
# domain (1), other title (2), process (3). Domain rules are evaluated only for
# browser sessions; process rules apply everywhere; title rules apply wherever
# their explicit scope allows.
_SEED_RULES: list[tuple[str, str, str, int]] = []

DEFAULT_SETTINGS = {
    "weekly_goal_hours": "0",
    "idle_threshold_seconds": "300",
    "heartbeat_seconds": "15",
    "week_start": "auto",
    "browser_processes": (
        "chrome.exe,msedge.exe,firefox.exe,opera.exe,brave.exe,vivaldi.exe"
    ),
    "min_app_seconds_per_day": "0",
    # Sites the reader added to the built-in media list in
    # tracker/media_playback.py, which stays in the code because it is product
    # knowledge. Empty on a fresh install: the built-ins already cover the
    # mainstream services, so this holds only what Time did not know about.
    "media_domains": "",
    # Activity Library noise filtering (dashboard-only; the tracker records
    # everything regardless). off | one_off | utilities_only | utilities --
    # where "utilities" is the historical value meaning *both* filters, not
    # utilities alone. Ships as utilities_only: see DEFAULT_NOISE_POLICY in
    # dashboard/src/lib/noise.ts for why rare items are no longer hidden by
    # default. Existing databases keep whatever they stored.
    "activity_noise_filter": "utilities_only",
    "activity_noise_max_seconds": "120",
    "activity_noise_max_sessions": "1",
    "color_palette": "slate",
    "productivity_style": "vivid",
    # Appearance (dashboard-only). dark | light | system; "system" follows the
    # OS so a light-mode user never gets a dark first run.
    "theme": "system",
    "focus_chain_max_gap_seconds": "300",
    "day_start_hour": "0",
    "day_end_hour": "24",
    # Pause state (written by the tray / dashboard, read by the tracker):
    # tracking_paused = "1" pauses until resumed; tracking_paused_until = unix
    # seconds pauses until that moment (self-resuming).
    "tracking_paused": "0",
    "tracking_paused_until": "0",
    # One recurring local-time recording window. For overnight ranges, a day
    # identifies when the window starts (Monday 22:00 continues into Tuesday).
    "tracking_schedule_enabled": "0",
    "tracking_schedule_days": DEFAULT_DAYS,
    "tracking_schedule_start_minute": str(DEFAULT_START_MINUTE),
    "tracking_schedule_end_minute": str(DEFAULT_END_MINUTE),
    # Tracking requires an explicit first-run choice. Window titles are a
    # separate opt-in because they can contain document names or message text.
    "recording_consent": "0",
    "record_window_titles": "0",
    # On by default, unlike the titles opt-in: a domain only reaches Time when
    # the reader has already installed the extension, which is the opt-in
    # gesture. This switch is for turning that back off without uninstalling it.
    "record_browser_domains": "1",
    "privacy_onboarding_complete": "0",
    "launch_at_login": "0",
    # Controls only the notification-area affordance. Recording and Windows
    # startup remain independent so hiding the icon cannot silently change
    # capture behavior.
    "show_tray_icon": "1",
    # Dashboard-only. Time's one outbound request: an unconditional GET of a
    # static version file, carrying nothing about the machine that asks. On by
    # default because an unpatchable bug on a local-history app is the worse
    # risk; the tracker never checks, and installing is always a user action.
    "check_updates_automatically": "1",
}


def normalize_browser_processes(raw: str) -> frozenset[str]:
    """Parse the comma-separated browser list into the shape sessions store.

    Win32 reports lowercase image names, so a match only lands when the setting
    is lowercase and carries the extension. Asking a user to know that is a
    trap: "Chrome" and a pasted install path both mean chrome.exe. The
    dashboard normalizes on save; this repeats it because the row can also be
    hand-edited or written by an older build.
    """
    names: set[str] = set()
    for part in raw.split(","):
        base = part.strip().lower().replace("\\", "/").rsplit("/", 1)[-1]
        if base:
            names.add(base if "." in base else base + ".exe")
    return frozenset(names)


def normalize_media_domains(raw: str) -> frozenset[str]:
    """Parse the comma-separated extra media sites into stored-host shape.

    The dashboard normalizes on save; this repeats it for the same reason
    `normalize_browser_processes` does — the row can also be hand-edited or
    written by an older build, and an entry that is not a normalized host would
    silently protect nothing.
    """
    hosts: set[str] = set()
    for part in raw.split(","):
        host = normalize_host(part)
        if host:
            hosts.add(host)
    return frozenset(hosts)


def pause_until(raw: dict[str, str]) -> float:
    """Return the persisted timed-pause boundary, or zero when malformed."""
    try:
        return float(raw.get("tracking_paused_until", "0"))
    except (TypeError, ValueError):
        return 0.0


def is_paused(raw: dict[str, str], now: float | None = None) -> bool:
    """True when tracking is paused, either indefinitely or until a future time."""
    return raw.get("tracking_paused") == "1" or (
        (now if now is not None else time.time()) < pause_until(raw)
    )


def tray_icon_enabled(raw: dict[str, str]) -> bool:
    """Missing upgrade-era values retain the historical visible-tray default."""
    return raw.get("show_tray_icon", DEFAULT_SETTINGS["show_tray_icon"]) != "0"


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
        # Before the first write of an upgrade, not after: _migrate rebuilds
        # tables, and a rolled-back transaction restores the schema but is no
        # comfort if the upgrade itself was the wrong call. Outside the
        # transaction below because VACUUM cannot run inside one.
        if existed and 0 < version < SCHEMA_VERSION:
            _backup_before_migration(conn, path, version)
        conn.executescript("BEGIN IMMEDIATE;\n" + _SCHEMA)
        try:
            _migrate(conn, version)
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


def _backup_before_migration(conn: sqlite3.Connection, path: Path, version: int) -> str:
    """Snapshot the database in its Backups folder and return the path written.

    VACUUM INTO rather than a file copy: it takes a consistent snapshot of a
    WAL database without having to reason about the -wal and -shm sidecars, and
    it is the same mechanism the dashboard's manual backup uses.
    """
    backup_dir = path.parent / "Backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"backup_schema{version}_{int(time.time())}.db"
    if target.exists():  # same-second retry; the older copy is the useful one
        return str(target)
    conn.execute("VACUUM INTO ?", (str(target),))
    logging.info("Backed up schema %s database to %s before migrating", version, target.name)
    return str(target)


def _migrate(conn: sqlite3.Connection, from_version: int) -> None:
    """Apply known upgrades inside open_db's single immediate transaction.

    Cumulative rather than one branch per starting point: a database two
    releases behind has to walk every step, so each block upgrades by one
    version and falls through to the next.
    """
    if from_version not in {0, 1, 2, 3, SCHEMA_VERSION}:
        raise RuntimeError(f"unsupported database schema {from_version}")
    if from_version == 0:
        return  # _SCHEMA is the authoritative fresh-install shape
    if from_version <= 1:
        # _SCHEMA is the authoritative fresh-install shape and has already run
        # with IF NOT EXISTS. These statements make the v1 -> v2 transition
        # explicit and restart-safe if a prior attempt stopped partway through.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tracking_exclusions ("
            "kind TEXT NOT NULL CHECK(kind IN ('app','website')),"
            "pattern TEXT NOT NULL,created_ts INTEGER NOT NULL,"
            "PRIMARY KEY(kind,pattern))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS session_corrections ("
            "session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,"
            "corrected_start_ts INTEGER,corrected_end_ts INTEGER,"
            "category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,"
            "updated_ts INTEGER NOT NULL,"
            "CHECK ((corrected_start_ts IS NULL AND corrected_end_ts IS NULL) OR "
            "(corrected_start_ts IS NOT NULL AND corrected_end_ts IS NOT NULL "
            "AND corrected_end_ts > corrected_start_ts)))"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_corrections_category "
            "ON session_corrections(category_id)"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS cleanup_empty_session_corrections "
            "AFTER DELETE ON categories FOR EACH ROW BEGIN "
            "DELETE FROM session_corrections WHERE corrected_start_ts IS NULL "
            "AND corrected_end_ts IS NULL AND category_id IS NULL; END"
        )
    if from_version <= 2:
        # Title rules gain a scope, which means widening UNIQUE(match_type,
        # pattern) to include it — the whole point being that the same words can
        # mean different things in different programs. A table constraint cannot
        # be altered in place, so this is SQLite's rebuild dance. _SCHEMA has
        # already run with IF NOT EXISTS and left the old table untouched, so
        # the new shape is spelled out again here rather than shared: the two
        # must be able to disagree while this block is running.
        #
        # Existing title rules land on '' (any app). They were browser-only
        # before, so a rule whose words also appear in an editor or note-taking
        # window will start matching there. That is the upgrade's intent, and
        # scoping the rule back to '@browsers' restores the old behaviour
        # exactly, because rules are evaluated against history rather than
        # written into session rows.
        conn.execute("DROP TRIGGER IF EXISTS delete_category_rules")
        conn.execute("DROP TABLE IF EXISTS rules_scoped")
        conn.execute(
            "CREATE TABLE rules_scoped ("
            "id INTEGER PRIMARY KEY,"
            "match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),"
            "pattern TEXT NOT NULL,"
            "category_id INTEGER NOT NULL REFERENCES categories(id),"
            "priority INTEGER NOT NULL DEFAULT 0,"
            "scope TEXT NOT NULL DEFAULT '' CHECK(scope = '' OR match_type = 'title'),"
            "UNIQUE(match_type, pattern, scope))"
        )
        conn.execute(
            "INSERT INTO rules_scoped (id, match_type, pattern, category_id, priority, scope)"
            " SELECT id, match_type, pattern, category_id, priority, '' FROM rules"
        )
        conn.execute("DROP TABLE rules")
        conn.execute("ALTER TABLE rules_scoped RENAME TO rules")
        conn.execute(_DELETE_CATEGORY_RULES_TRIGGER)
    if from_version <= 3:
        # A v3 title pattern was only a lowercased substring with a coarse scope.
        # There is no honest way to infer whether its owner meant a whole
        # phrase, one exact title segment, or the legacy contains behavior.
        # Preserve App and Website rules exactly; reset Window rules and leave a
        # durable notice for the dashboard. This is safer than silently giving
        # an old broad pattern a new meaning over all historical sessions.
        title_rule_count = conn.execute(
            "SELECT COUNT(*) FROM rules WHERE match_type='title'"
        ).fetchone()[0]
        conn.execute("DROP TRIGGER IF EXISTS delete_category_rules")
        conn.execute("DROP TABLE IF EXISTS rules_window_v4")
        conn.execute(
            "CREATE TABLE rules_window_v4 ("
            "id INTEGER PRIMARY KEY,"
            "match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),"
            "pattern TEXT NOT NULL,"
            "category_id INTEGER NOT NULL REFERENCES categories(id),"
            "priority INTEGER NOT NULL DEFAULT 0,"
            "scope_kind TEXT NOT NULL DEFAULT '' "
            "CHECK(scope_kind IN ('','any','browsers','process','domain')),"
            "scope_value TEXT NOT NULL DEFAULT '',"
            "title_match_mode TEXT NOT NULL DEFAULT '' "
            "CHECK(title_match_mode IN ('','segment','phrase','contains')),"
            "title_anchor TEXT NOT NULL DEFAULT '' "
            "CHECK(title_anchor IN ('','any','first','interior','last')),"
            "CHECK ("
            "(match_type='title' "
            "AND scope_kind IN ('any','browsers','process','domain') "
            "AND title_match_mode IN ('segment','phrase','contains') "
            "AND title_anchor IN ('any','first','interior','last') "
            "AND (title_match_mode='segment' OR title_anchor='any') "
            "AND (((scope_kind IN ('any','browsers')) AND scope_value='') "
            "OR (scope_kind IN ('process','domain') AND length(scope_value)>0))) "
            "OR (match_type<>'title' AND scope_kind='' AND scope_value='' "
            "AND title_match_mode='' AND title_anchor='')),"
            "UNIQUE(match_type,pattern,scope_kind,scope_value,title_match_mode,title_anchor))"
        )
        conn.execute(
            "INSERT INTO rules_window_v4 "
            "(id,match_type,pattern,category_id,priority) "
            "SELECT id,match_type,pattern,category_id,priority FROM rules "
            "WHERE match_type<>'title'"
        )
        conn.execute("DROP TABLE rules")
        conn.execute("ALTER TABLE rules_window_v4 RENAME TO rules")
        conn.execute(_DELETE_CATEGORY_RULES_TRIGGER)
        if title_rule_count:
            conn.execute(
                "INSERT INTO settings (key,value) VALUES "
                "('window_rules_reset_v4_count',?),('window_rules_reset_v4_pending','1') "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(title_rule_count),),
            )


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


def set_settings(conn: sqlite3.Connection, values: dict[str, str]) -> None:
    """Persist settings through the database-owned upsert contract."""
    conn.executemany(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        values.items(),
    )


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    set_settings(conn, {key: value})


def get_settings(conn: sqlite3.Connection, now: float | None = None) -> Settings:
    """Tracker-relevant settings, parsed and validated with safe fallbacks."""
    raw = read_settings_raw(conn)

    def _float(key: str, default: float, lo: float, hi: float) -> float:
        try:
            val = float(raw.get(key, default))
        except (TypeError, ValueError):
            return default
        return min(max(val, lo), hi)

    browsers = normalize_browser_processes(
        raw.get("browser_processes", DEFAULT_SETTINGS["browser_processes"])
    )
    exclusions = conn.execute(
        "SELECT kind, pattern FROM tracking_exclusions"
    ).fetchall()
    excluded_processes = frozenset(
        row["pattern"].lower() for row in exclusions if row["kind"] == "app"
    )
    excluded_domains = frozenset(
        row["pattern"].lower() for row in exclusions if row["kind"] == "website"
    )
    recording_schedule = schedule_state(raw, now)
    return Settings(
        idle_threshold_seconds=_float("idle_threshold_seconds", 300.0, 30.0, 3600.0),
        heartbeat_seconds=_float("heartbeat_seconds", 15.0, 5.0, 300.0),
        browser_processes=browsers
        or normalize_browser_processes(DEFAULT_SETTINGS["browser_processes"]),
        tracking_paused=is_paused(raw, now),
        recording_schedule_allowed=recording_schedule.recording_allowed,
        recording_schedule_window_start=recording_schedule.current_window_start or 0.0,
        recording_consent=raw.get("recording_consent") == "1",
        record_window_titles=raw.get("record_window_titles") == "1",
        # Defaults on for a key that may be absent, unlike the titles opt-in
        # above. A database written before this setting existed was recording
        # domains, and reading a missing key as "off" would silently stop that
        # on upgrade.
        record_browser_domains=raw.get("record_browser_domains", "1") == "1",
        excluded_processes=excluded_processes,
        excluded_domains=excluded_domains,
        media_domains=normalize_media_domains(raw.get("media_domains", "")),
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
    ) -> int | None:
        def _do() -> int | None:
            cur = self._conn.execute(
                "INSERT INTO sessions (start_ts, end_ts, process, title, domain, is_afk, source)"
                " SELECT ?,?,?,?,?,?,'live'"
                " WHERE ? OR NOT EXISTS ("
                " SELECT 1 FROM tracking_exclusions"
                " WHERE (kind='app' AND pattern=lower(?))"
                " OR (kind='website' AND ? IS NOT NULL AND pattern=lower(?))"
                " )",
                (
                    int(start_ts), int(start_ts), process, title[:512], domain, int(is_afk),
                    int(is_afk), process, domain, domain,
                ),
            )
            if cur.rowcount == 0:
                return None
            return int(cur.lastrowid)

        session_id = _retry(_do, op="open_session")
        # DEBUG, not INFO: window titles are sensitive, and an INFO-level log
        # would archive them in plain text alongside the database.
        if session_id is not None:
            logging.debug("OPEN  %s | %s", process, title[:120])
        return session_id

    def _advance_session_end(self, session_id: int, end_ts: float, *, op: str) -> None:
        _retry(
            lambda: self._conn.execute(
                "UPDATE sessions SET end_ts = ? WHERE id = ?", (int(end_ts), session_id)
            ),
            op=op,
        )

    def close_session(self, session_id: int, end_ts: float) -> None:
        self._advance_session_end(session_id, end_ts, op="close_session")
        logging.debug("CLOSE #%s @ %s", session_id, int(end_ts))

    def heartbeat(self, session_id: int, end_ts: float) -> None:
        self._advance_session_end(session_id, end_ts, op="heartbeat")
