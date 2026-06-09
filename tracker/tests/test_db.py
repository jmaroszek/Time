import sqlite3

import pytest

from tracker import db


@pytest.fixture
def conn(tmp_path):
    c = db.open_db(tmp_path / "test.db")
    yield c
    c.close()


def test_bootstrap_is_idempotent(tmp_path):
    path = tmp_path / "test.db"
    c1 = db.open_db(path)
    n_cats = c1.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    n_rules = c1.execute("SELECT COUNT(*) FROM rules").fetchone()[0]
    c1.close()
    c2 = db.open_db(path)
    assert c2.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == n_cats
    assert c2.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == n_rules
    c2.close()


def test_seed_categories_and_settings_present(conn):
    names = {r["name"] for r in conn.execute("SELECT name FROM categories")}
    assert {"Notes", "Dev", "AI tools", "Gaming", "Media", "System"} <= names
    raw = db.read_settings_raw(conn)
    assert raw["weekly_goal_hours"] == "20"
    assert raw["week_start"] == "Sunday"


def test_seed_does_not_overwrite_user_settings(tmp_path):
    path = tmp_path / "test.db"
    c = db.open_db(path)
    c.execute("UPDATE settings SET value='35' WHERE key='weekly_goal_hours'")
    c.close()
    c = db.open_db(path)
    assert db.read_settings_raw(c)["weekly_goal_hours"] == "35"
    c.close()


def test_ignored_category_seeded_and_column_added_to_old_db(tmp_path):
    # Simulate a DB created before the is_ignored column existed.
    path = tmp_path / "old.db"
    c = sqlite3.connect(path)
    c.execute(
        """CREATE TABLE categories (
            id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL,
            is_productive INTEGER NOT NULL DEFAULT 0, sort_order INTEGER)"""
    )
    c.execute("INSERT INTO categories (name, color) VALUES ('Dev', '#000')")
    c.commit()
    c.close()

    conn = db.open_db(path)
    cols = {row[1] for row in conn.execute("PRAGMA table_info(categories)")}
    assert "is_ignored" in cols
    assert conn.execute(
        "SELECT is_ignored FROM categories WHERE name='Ignored'"
    ).fetchone()[0] == 1
    # pre-existing rows preserved and defaulted to not-ignored
    assert conn.execute(
        "SELECT is_ignored FROM categories WHERE name='Dev'"
    ).fetchone()[0] == 0
    conn.close()


def test_ignored_seed_is_idempotent(tmp_path):
    path = tmp_path / "test.db"
    db.open_db(path).close()
    conn = db.open_db(path)
    n = conn.execute("SELECT COUNT(*) FROM categories WHERE name='Ignored'").fetchone()[0]
    assert n == 1
    conn.close()


def test_get_settings_parses_and_clamps(conn):
    s = db.get_settings(conn)
    assert s.idle_threshold_seconds == 180.0
    assert s.heartbeat_seconds == 15.0
    assert "chrome.exe" in s.browser_processes

    conn.execute("UPDATE settings SET value='5' WHERE key='idle_threshold_seconds'")
    assert db.get_settings(conn).idle_threshold_seconds == 30.0  # clamped to floor

    conn.execute("UPDATE settings SET value='garbage' WHERE key='idle_threshold_seconds'")
    assert db.get_settings(conn).idle_threshold_seconds == 180.0  # fallback


def test_store_open_heartbeat_close_roundtrip(conn):
    store = db.SqliteStore(conn)
    sid = store.open_session(1000.0, "code.exe", "main.py", None, False)
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    assert (row["start_ts"], row["end_ts"], row["process"]) == (1000, 1000, "code.exe")
    assert row["source"] == "live"

    store.heartbeat(sid, 1015.0)
    assert conn.execute("SELECT end_ts FROM sessions WHERE id=?", (sid,)).fetchone()[0] == 1015

    store.close_session(sid, 1020.0)
    assert conn.execute("SELECT end_ts FROM sessions WHERE id=?", (sid,)).fetchone()[0] == 1020


def test_store_truncates_long_titles(conn):
    store = db.SqliteStore(conn)
    sid = store.open_session(1000.0, "x.exe", "t" * 2000, None, False)
    title = conn.execute("SELECT title FROM sessions WHERE id=?", (sid,)).fetchone()[0]
    assert len(title) == 512


def test_retry_recovers_from_transient_lock(monkeypatch):
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise sqlite3.OperationalError("database is locked")
        return "ok"

    monkeypatch.setattr(db.time, "sleep", lambda _x: None)
    assert db._retry(flaky) == "ok"
    assert calls["n"] == 3


def test_retry_gives_up_after_attempts(monkeypatch):
    def always_locked():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(db.time, "sleep", lambda _x: None)
    with pytest.raises(sqlite3.OperationalError):
        db._retry(always_locked, attempts=3)
