"""Migration transactions must survive errors and exits during table rebuilds."""

import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from tracker import db


FAULT_WORKER = """
import os, sqlite3, sys
from tracker import db
original_connect = sqlite3.connect
class FaultConnection(sqlite3.Connection):
    def execute(self, sql, *args, **kwargs):
        result = super().execute(sql, *args, **kwargs)
        if sql.startswith(sys.argv[2]):
            if sys.argv[3] == 'exit':
                os._exit(23)
            raise RuntimeError('injected migration failure')
        return result
db.sqlite3.connect = lambda *args, **kwargs: original_connect(
    *args, **kwargs, factory=FaultConnection)
try:
    db.open_db(sys.argv[1]).close()
except RuntimeError:
    sys.exit(24)
"""


def legacy_database(path):
    with sqlite3.connect(path) as conn:
        conn.executescript(
            "CREATE TABLE sessions (id INTEGER PRIMARY KEY,start_ts INTEGER NOT NULL,"
            "end_ts INTEGER NOT NULL,process TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',"
            "domain TEXT,is_afk INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'live');"
            "CREATE TABLE categories (id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,"
            "color TEXT NOT NULL,is_productive INTEGER NOT NULL DEFAULT 0,"
            "is_neutral INTEGER NOT NULL DEFAULT 0,is_ignored INTEGER NOT NULL DEFAULT 0,"
            "sort_order INTEGER);"
            "CREATE TABLE rules (id INTEGER PRIMARY KEY,match_type TEXT NOT NULL,pattern TEXT NOT NULL,"
            "category_id INTEGER NOT NULL REFERENCES categories(id),priority INTEGER NOT NULL DEFAULT 0,"
            "scope TEXT NOT NULL DEFAULT '',UNIQUE(match_type,pattern,scope));"
            "CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);"
            "INSERT INTO settings VALUES ('schema_version','3');"
            "INSERT INTO categories(id,name,color) VALUES(1,'Custom','#abcdef');"
            "INSERT INTO rules VALUES(1,'process','editor.exe',1,3,''),(2,'title','notes',1,2,'');"
            "INSERT INTO sessions(id,start_ts,end_ts,process) VALUES(7,10,20,'editor.exe');"
        )
        return list(conn.iterdump())


@pytest.mark.parametrize("mode", ["error", "exit"])
@pytest.mark.parametrize("statement", [
    "DROP TABLE rules",
    "ALTER TABLE rules_window_v4 RENAME TO rules",
    "ALTER TABLE categories ADD COLUMN goal_kind",
    "INSERT INTO settings (key,value) VALUES ('schema_version',?)",
])
def test_interrupted_migration_preserves_original_and_can_retry(tmp_path, mode, statement):
    path = tmp_path / "v3.db"
    original = legacy_database(path)
    result = subprocess.run(
        [sys.executable, "-c", FAULT_WORKER, str(path), statement, mode],
        cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == (23 if mode == "exit" else 24), result.stderr
    with sqlite3.connect(path) as conn:
        assert list(conn.iterdump()) == original
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    backups = list((tmp_path / "Backups").glob("backup_schema3_*.db"))
    assert backups
    with sqlite3.connect(backups[0]) as backup:
        assert list(backup.iterdump()) == original
    conn = db.open_db(path)
    try:
        assert db.read_settings_raw(conn)["schema_version"] == str(db.SCHEMA_VERSION)
        assert [tuple(row) for row in conn.execute(
            "SELECT id,start_ts,end_ts,process FROM sessions"
        )] == [(7, 10, 20, "editor.exe")]
        assert [tuple(row) for row in conn.execute("SELECT id,pattern FROM rules")] == [(1, "editor.exe")]
        assert db.read_settings_raw(conn)["window_rules_reset_v4_count"] == "1"
        assert list(conn.execute("PRAGMA foreign_key_check")) == []
    finally:
        conn.close()


def test_second_opener_does_not_repeat_a_completed_migration(tmp_path, monkeypatch):
    path = tmp_path / "v3.db"
    legacy_database(path)
    backup = db._backup_before_migration

    def another_opener_finishes_first(conn, path, version):
        monkeypatch.setattr(db, "_backup_before_migration", backup)
        other = db.open_db(path)
        try:
            other.execute(
                "INSERT INTO rules(id,match_type,pattern,category_id,priority,scope_kind,"
                "scope_value,title_match_mode,title_anchor)"
                " VALUES(10,'title','new rule',1,2,'any','','phrase','any')"
            )
        finally:
            other.close()
        return backup(conn, path, version)

    monkeypatch.setattr(db, "_backup_before_migration", another_opener_finishes_first)
    conn = db.open_db(path)
    try:
        assert [tuple(row) for row in conn.execute(
            "SELECT id,pattern FROM rules ORDER BY id"
        )] == [(1, "editor.exe"), (10, "new rule")]
    finally:
        conn.close()
