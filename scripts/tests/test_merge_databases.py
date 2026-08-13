from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from scripts.merge_databases import MergeError, main, merge_databases
from tracker.db import open_db


def _category(conn: sqlite3.Connection, name: str, color: str = "#111111") -> int:
    cursor = conn.execute(
        "INSERT INTO categories (name,color,is_productive,is_neutral,is_ignored,sort_order)"
        " VALUES (?,?,0,0,0,NULL)",
        (name, color),
    )
    return int(cursor.lastrowid)


def _session(conn: sqlite3.Connection, start: int, end: int, process: str = "code.exe") -> int:
    cursor = conn.execute(
        "INSERT INTO sessions (start_ts,end_ts,process,title,domain,is_afk,source)"
        " VALUES (?,?,?,'',NULL,0,'live')",
        (start, end, process),
    )
    return int(cursor.lastrowid)


def _rule(conn: sqlite3.Connection, pattern: str, category_id: int) -> None:
    conn.execute(
        "INSERT INTO rules (match_type,pattern,category_id,priority) VALUES ('process',?,?,0)",
        (pattern, category_id),
    )


def _id(conn: sqlite3.Connection, name: str) -> int:
    return int(conn.execute("SELECT id FROM categories WHERE name=?", (name,)).fetchone()[0])


def _base(path: Path) -> sqlite3.Connection:
    """A stand-in for the archived database: hand-built categories, not starters.

    A fresh database seeds the onboarding starter set, so the fixture clears it
    and rebuilds the shape a long-running profile actually has. Browsing and
    System survive that rebuild because they are the names both sides share,
    which is the collision the merge has to resolve.
    """
    conn = open_db(path)
    conn.execute("DELETE FROM categories")
    dev = _category(conn, "Dev")
    _category(conn, "Browsing")
    _category(conn, "System")
    _rule(conn, "code.exe", dev)
    for index in range(5):
        _session(conn, 1_000 + index * 100, 1_050 + index * 100)
    return conn


def _donor(path: Path) -> sqlite3.Connection:
    """A stand-in for the trial profile: the starter categories plus a week."""
    conn = open_db(path)
    _rule(conn, "chrome.exe", _id(conn, "Work"))
    for index in range(3):
        _session(conn, 9_000 + index * 100, 9_050 + index * 100, "chrome.exe")
    return conn


def test_imports_donor_history_without_colliding_session_ids(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    _donor(donor_path).close()

    report = merge_databases(base_path, donor_path, out)

    with sqlite3.connect(out) as merged:
        ids = [row[0] for row in merged.execute("SELECT id FROM sessions ORDER BY id")]
        assert len(ids) == 8
        assert len(set(ids)) == 8
        assert merged.execute("SELECT COUNT(*) FROM sessions WHERE start_ts>=9000").fetchone()[0] == 3
    assert report["sessions_imported"] == 3
    assert report["session_id_offset"] == 5


def test_reconciles_categories_by_name_and_keeps_base_rules(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    _donor(donor_path).close()

    report = merge_databases(base_path, donor_path, out)

    with sqlite3.connect(out) as merged:
        names = [row[0] for row in merged.execute("SELECT name FROM categories ORDER BY name")]
        assert names == ["Browsing", "Dev", "System"]
        rules = [row[0] for row in merged.execute("SELECT pattern FROM rules")]
        assert rules == ["code.exe"]
    assert report["categories_matched_by_name"] == ["Browsing", "System"]
    assert report["categories_imported"] == []
    assert report["rules_imported"] == 0
    assert report["rules_skipped"] == 1


def test_remaps_a_donor_correction_onto_its_moved_session(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    donor = _donor(donor_path)
    system_id = _id(donor, "System")
    donor.execute(
        "INSERT INTO session_corrections (session_id,category_id,updated_ts) VALUES (1,?,7)",
        (system_id,),
    )
    donor.close()

    report = merge_databases(base_path, donor_path, out)

    with sqlite3.connect(out) as merged:
        row = merged.execute(
            "SELECT session_id,category_id FROM session_corrections"
        ).fetchone()
        session_start = merged.execute(
            "SELECT start_ts FROM sessions WHERE id=?", (row[0],)
        ).fetchone()[0]
        merged_system = merged.execute(
            "SELECT id FROM categories WHERE name='System'"
        ).fetchone()[0]
        assert row[0] == 6
        assert session_start == 9_000
        assert row[1] == merged_system
        assert not list(merged.execute("PRAGMA foreign_key_check"))
    assert report["corrections_imported"] == 1


def test_includes_history_still_sitting_in_the_donor_write_ahead_log(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    donor = _donor(donor_path)
    donor.execute("PRAGMA wal_autocheckpoint=0")
    _session(donor, 9_900, 9_950, "uncheckpointed.exe")
    try:
        assert donor_path.with_name("d.db-wal").stat().st_size > 0

        merge_databases(base_path, donor_path, out)

        with sqlite3.connect(out) as merged:
            processes = {row[0] for row in merged.execute("SELECT process FROM sessions")}
            assert "uncheckpointed.exe" in processes
    finally:
        donor.close()


def test_leaves_both_inputs_untouched(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    _donor(donor_path).close()
    before = (base_path.read_bytes(), donor_path.read_bytes())

    merge_databases(base_path, donor_path, out)

    assert (base_path.read_bytes(), donor_path.read_bytes()) == before


def test_keeps_donor_rules_on_request_and_reports_unique_conflicts(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    base = _base(base_path)
    browsing = _id(base, "Browsing")
    _rule(base, "chrome.exe", browsing)
    base.close()
    donor = _donor(donor_path)
    system_id = _id(donor, "System")
    _rule(donor, "explorer.exe", system_id)
    donor.close()

    report = merge_databases(base_path, donor_path, out, donor_rules="keep")

    with sqlite3.connect(out) as merged:
        kept = merged.execute(
            "SELECT c.name FROM rules r JOIN categories c ON c.id=r.category_id"
            " WHERE r.pattern='explorer.exe'"
        ).fetchone()[0]
        # The donor's own chrome.exe rule loses to the base's identical pattern.
        assert merged.execute(
            "SELECT COUNT(*) FROM rules WHERE pattern='chrome.exe'"
        ).fetchone()[0] == 1
    assert kept == "System"
    assert report["rules_imported"] == 1
    assert report["rules_conflicted"] == 1
    # The donor's Work category backs a rule, so keeping rules imports it.
    assert report["categories_imported"] == ["Work"]


def test_drops_a_correction_whose_category_is_not_imported(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    donor = _donor(donor_path)
    work = _id(donor, "Work")
    donor.execute(
        "INSERT INTO session_corrections (session_id,category_id,updated_ts) VALUES (1,?,7)",
        (work,),
    )
    donor.close()

    report = merge_databases(base_path, donor_path, out, donor_categories="none")

    with sqlite3.connect(out) as merged:
        assert merged.execute("SELECT COUNT(*) FROM session_corrections").fetchone()[0] == 0
        assert not list(merged.execute("PRAGMA foreign_key_check"))
    assert report["corrections_dropped"] == 1


def test_unions_tracking_exclusions_and_adds_only_new_settings(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    base = _base(base_path)
    base.execute(
        "INSERT INTO tracking_exclusions (kind,pattern,created_ts) VALUES ('app','secret.exe',1)"
    )
    base.execute("UPDATE settings SET value='1' WHERE key='week_start'")
    base.close()
    donor = _donor(donor_path)
    donor.execute(
        "INSERT INTO tracking_exclusions (kind,pattern,created_ts) VALUES"
        " ('app','secret.exe',9),('website','bank.com',9)"
    )
    donor.execute("UPDATE settings SET value='6' WHERE key='week_start'")
    donor.execute("INSERT INTO settings (key,value) VALUES ('trial_only','1')")
    donor.close()

    report = merge_databases(base_path, donor_path, out)

    with sqlite3.connect(out) as merged:
        exclusions = dict(
            merged.execute("SELECT pattern,created_ts FROM tracking_exclusions")
        )
        assert exclusions == {"secret.exe": 1, "bank.com": 9}
        settings = dict(merged.execute("SELECT key,value FROM settings"))
        assert settings["week_start"] == "1"
        assert settings["trial_only"] == "1"
    assert report["exclusions_imported"] == 1
    assert report["settings_added"] == ["trial_only"]


def test_reports_overlapping_history_without_refusing_the_merge(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    base = _base(base_path)
    _session(base, 9_100, 9_400)
    base.close()
    _donor(donor_path).close()

    report = merge_databases(base_path, donor_path, out)

    assert report["overlapping_seconds"] == 400


def test_refuses_a_donor_at_a_different_schema_version(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    donor = _donor(donor_path)
    donor.execute("UPDATE settings SET value='3' WHERE key='schema_version'")
    donor.close()

    with pytest.raises(MergeError, match="schema 3"):
        merge_databases(base_path, donor_path, out)
    assert not out.exists()


def test_refuses_to_overwrite_an_existing_output_or_an_input(tmp_path: Path):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    _donor(donor_path).close()
    out.write_bytes(b"")

    with pytest.raises(MergeError, match="already exists"):
        merge_databases(base_path, donor_path, out)
    with pytest.raises(MergeError, match="overwrite an input"):
        merge_databases(base_path, donor_path, base_path)


def test_cli_reports_the_merge(tmp_path: Path, capsys):
    base_path, donor_path, out = tmp_path / "b.db", tmp_path / "d.db", tmp_path / "m.db"
    _base(base_path).close()
    _donor(donor_path).close()

    code = main(
        ["--base", str(base_path), "--donor", str(donor_path), "--output", str(out), "--json"]
    )

    captured = capsys.readouterr()
    assert code == 0
    assert '"sessions_imported": 3' in captured.out


def test_cli_fails_loudly_on_a_missing_input(tmp_path: Path, capsys):
    code = main(
        [
            "--base",
            str(tmp_path / "missing.db"),
            "--donor",
            str(tmp_path / "also-missing.db"),
            "--output",
            str(tmp_path / "m.db"),
        ]
    )

    assert code == 1
    assert "merge failed" in capsys.readouterr().err
