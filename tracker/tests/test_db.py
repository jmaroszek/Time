import sqlite3
from pathlib import Path

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
    rows = conn.execute(
        "SELECT name, is_productive, is_neutral, is_ignored FROM categories"
        " ORDER BY sort_order"
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("Focus", 1, 0, 0),
        ("Learning", 1, 0, 0),
        ("Communication", 0, 1, 0),
        ("Entertainment", 0, 0, 0),
        ("Utilities", 0, 1, 0),
        ("Ignored", 0, 0, 1),
    ]
    assert conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 0
    raw = db.read_settings_raw(conn)
    assert raw["weekly_goal_hours"] == "0"
    assert raw["week_start"] == "auto"
    assert raw["recording_consent"] == "0"
    assert raw["record_window_titles"] == "0"
    assert raw["privacy_onboarding_complete"] == "0"
    assert raw["starter_categories_pending"] == "1"
    assert raw["schema_version"] == str(db.SCHEMA_VERSION)


def test_seed_does_not_add_starter_categories_to_existing_taxonomy(tmp_path):
    path = tmp_path / "existing.db"
    conn = sqlite3.connect(path)
    conn.executescript(db._SCHEMA)
    conn.execute(
        "INSERT INTO categories (name,color,sort_order) VALUES ('Personal','#123456',1)"
    )
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('schema_version',?)",
        (str(db.SCHEMA_VERSION),),
    )
    conn.commit()
    conn.close()

    conn = db.open_db(path)
    assert [
        row[0] for row in conn.execute("SELECT name FROM categories ORDER BY sort_order")
    ] == ["Personal"]
    assert "starter_categories_pending" not in db.read_settings_raw(conn)
    conn.close()


def test_current_schema_constraints_and_category_cleanup(conn):
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO sessions (start_ts,end_ts,process) VALUES (20,10,'bad.exe')")
    category_id = conn.execute(
        "INSERT INTO categories (name,color) VALUES ('Work','#123456') RETURNING id"
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO rules (match_type,pattern,category_id,priority) VALUES ('process','editor.exe',?,3)",
        (category_id,),
    )
    conn.execute("DELETE FROM categories WHERE id=?", (category_id,))
    assert conn.execute("SELECT COUNT(*) FROM rules WHERE category_id=?", (category_id,)).fetchone()[0] == 0
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_tracker_refuses_newer_schema_without_mutating_it(tmp_path):
    path = tmp_path / "newer.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);"
        "CREATE TABLE sentinel (value TEXT);"
        "INSERT INTO settings VALUES ('schema_version','2');"
        "INSERT INTO sentinel VALUES ('untouched');"
    )
    conn.close()

    with pytest.raises(db.SchemaTooNewError, match="newer than tracker schema"):
        db.open_db(path)

    conn = sqlite3.connect(path)
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert tables == {"settings", "sentinel"}
    assert conn.execute("SELECT value FROM sentinel").fetchone()[0] == "untouched"
    conn.close()


def test_tracker_refuses_unversioned_pre_release_database(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY)")
    conn.close()
    with pytest.raises(RuntimeError, match="unversioned pre-release database"):
        db.open_db(path)


def test_seed_does_not_overwrite_user_settings(tmp_path):
    path = tmp_path / "test.db"
    c = db.open_db(path)
    c.execute("UPDATE settings SET value='35' WHERE key='weekly_goal_hours'")
    c.close()
    c = db.open_db(path)
    assert db.read_settings_raw(c)["weekly_goal_hours"] == "35"
    c.close()


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
    assert s.recording_consent is False
    assert s.record_window_titles is False

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


# ---------------- pause state (PROD-001) ----------------


def test_is_paused_indefinite_flag():
    assert db.is_paused({"tracking_paused": "1"}) is True
    assert db.is_paused({"tracking_paused": "0"}) is False
    assert db.is_paused({}) is False


def test_is_paused_timed():
    assert db.is_paused({"tracking_paused_until": "2000"}, now=1000.0) is True
    assert db.is_paused({"tracking_paused_until": "2000"}, now=3000.0) is False
    assert db.is_paused({"tracking_paused_until": "garbage"}, now=1000.0) is False


def test_get_settings_reads_pause_state(conn):
    assert db.get_settings(conn).tracking_paused is False
    conn.execute("UPDATE settings SET value='1' WHERE key='tracking_paused'")
    assert db.get_settings(conn).tracking_paused is True


def test_tray_pause_roundtrip(tmp_path):
    from tracker import tray

    path = tmp_path / "test.db"
    db.open_db(path).close()
    tray._write_pause(path, "0", 4102444800)  # far future
    paused, until = tray._read_pause_state(path)
    assert paused is True and until == 4102444800
    tray._write_pause(path, "0", 0)
    paused, _until = tray._read_pause_state(path)
    assert paused is False


def test_tray_uses_frozen_icon(monkeypatch, tmp_path):
    from tracker import tray

    icon = tmp_path / "assets" / "icon.ico"
    icon.parent.mkdir()
    icon.write_bytes(b"icon")
    monkeypatch.setattr(tray.sys, "_MEIPASS", str(tmp_path), raising=False)
    assert tray._icon_path() == icon


def test_tray_finds_dashboard_beside_packaged_tracker(monkeypatch, tmp_path):
    from tracker import tray

    tracker_exe = tmp_path / "time-tracker.exe"
    dashboard_exe = tmp_path / "Time.exe"
    dashboard_exe.write_bytes(b"dashboard")
    monkeypatch.delenv("TIME_DASHBOARD_PATH", raising=False)
    monkeypatch.setattr(tray.sys, "frozen", True, raising=False)
    monkeypatch.setattr(tray.sys, "executable", str(tracker_exe))
    assert tray._dashboard_path() == dashboard_exe


def test_packaged_tracker_ignores_dashboard_path_override(monkeypatch, tmp_path):
    from tracker import tray

    tracker_exe = tmp_path / "time-tracker.exe"
    dashboard_exe = tmp_path / "Time.exe"
    override = tmp_path / "untrusted.exe"
    dashboard_exe.write_bytes(b"dashboard")
    override.write_bytes(b"override")
    monkeypatch.setenv("TIME_DASHBOARD_PATH", str(override))
    monkeypatch.setattr(tray.sys, "frozen", True, raising=False)
    monkeypatch.setattr(tray.sys, "executable", str(tracker_exe))
    assert tray._dashboard_path() == dashboard_exe


def test_packaged_tracker_ignores_data_directory_override(monkeypatch, tmp_path):
    from tracker import config

    monkeypatch.setenv("TIME_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config.sys, "frozen", True, raising=False)
    assert config._data_dir() == Path(config.os.environ["LOCALAPPDATA"]) / "Time"
