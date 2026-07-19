from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from scripts.check_db_anomalies import check_database, main
from tracker.db import open_db


def _by_name(checks):
    return {check["name"]: check for check in checks}


def test_clean_schema_v1_database_passes_read_only(tmp_path: Path):
    db_path = tmp_path / "clean.db"
    conn = open_db(db_path)
    conn.execute(
        "INSERT INTO sessions"
        " (start_ts,end_ts,process,title,domain,is_afk,source)"
        " VALUES (100,200,'code.exe','Code',NULL,0,'live'),"
        " (200,300,'afk','idle',NULL,1,'live')"
    )
    before = conn.total_changes
    conn.close()

    checks = check_database(db_path, now=1_000)

    assert all(check["ok"] for check in checks)
    with sqlite3.connect(db_path) as verify:
        assert verify.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2
    assert before > 0


def test_detects_legacy_anomalies_without_repairing_them(tmp_path: Path):
    db_path = tmp_path / "dirty.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE sessions (
                id INTEGER PRIMARY KEY, start_ts INTEGER, end_ts INTEGER,
                process TEXT, title TEXT, domain TEXT, is_afk INTEGER, source TEXT
            );
            CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, color TEXT);
            CREATE TABLE rules (
                id INTEGER PRIMARY KEY, match_type TEXT, pattern TEXT,
                category_id INTEGER REFERENCES categories(id), priority INTEGER
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO settings VALUES ('schema_version','1'),('heartbeat_seconds','15');
            INSERT INTO categories VALUES (1,'Dev','#000000');
            INSERT INTO sessions VALUES
                (1,100,200,'code.exe','',NULL,0,'live'),
                (2,150,250,'code.exe','',NULL,0,'live'),
                (3,300,299,'code.exe','',NULL,0,'live'),
                (4,400,400,'code.exe','',NULL,0,'live'),
                (5,500,600,'afk','idle','example.com',1,'live'),
                (6,600,700,'','','',7,'live');
            INSERT INTO rules VALUES
                (1,'process','code.exe',1,3),
                (2,'process','code.exe',1,3),
                (3,'wat','',999,3);
            """
        )

    checks = _by_name(check_database(db_path, now=1_000))

    for name in (
        "negative_duration_sessions",
        "stale_zero_duration_sessions",
        "overlapping_sessions",
        "afk_sessions_with_domains",
        "invalid_afk_flags",
        "empty_process_names",
        "duplicate_rules",
        "orphan_rules",
        "invalid_rule_types",
        "empty_rule_patterns",
        "foreign_key_check",
    ):
        assert checks[name]["ok"] is False, name
        assert checks[name]["count"] >= 1, name

    with sqlite3.connect(db_path) as verify:
        assert verify.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 6
        assert verify.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 3


def test_missing_contract_tables_fails_cleanly(tmp_path: Path):
    db_path = tmp_path / "empty.db"
    sqlite3.connect(db_path).close()

    checks = _by_name(check_database(db_path))

    assert checks["integrity_check"]["ok"] is True
    assert checks["required_tables"]["ok"] is False
    assert checks["required_tables"]["count"] == 4


def test_json_cli_exit_codes(tmp_path: Path, capsys):
    db_path = tmp_path / "clean.db"
    open_db(db_path).close()

    assert main([str(db_path), "--json", "--now", "1000"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["database"] == str(db_path.resolve())

    missing = tmp_path / "missing.db"
    assert main([str(missing), "--json"]) == 2
    error = json.loads(capsys.readouterr().out)
    assert "error" in error
