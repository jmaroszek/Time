"""Migration tests against synthetic time_log fixtures in a tmp DB."""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from migrate_samples import collapse_samples, migrate, split_session_per_day

from tracker import db as tracker_db

POLL = 15.0


def ts(h: int, m: int = 0, s: int = 0, day: int = 15) -> int:
    return int(datetime(2026, 6, day, h, m, s).timestamp())


# ---------------- collapse_samples ----------------


def test_consecutive_samples_merge():
    rows = [(1000 + i * 15, "code.exe", "main.py", POLL) for i in range(10)]
    sessions = list(collapse_samples(rows))
    assert sessions == [(1000, 1000 + 9 * 15 + 15, "code.exe", "main.py")]


def test_title_change_splits():
    rows = [
        (1000, "chrome.exe", "A", POLL),
        (1015, "chrome.exe", "A", POLL),
        (1030, "chrome.exe", "B", POLL),
    ]
    sessions = list(collapse_samples(rows))
    assert len(sessions) == 2
    assert sessions[0] == (1000, 1030, "chrome.exe", "A")
    assert sessions[1] == (1030, 1045, "chrome.exe", "B")


def test_process_change_splits():
    rows = [
        (1000, "code.exe", "x", POLL),
        (1015, "obsidian.exe", "x", POLL),
    ]
    assert len(list(collapse_samples(rows))) == 2


def test_gap_beyond_tolerance_splits():
    rows = [
        (1000, "code.exe", "x", POLL),
        (1015, "code.exe", "x", POLL),
        (1100, "code.exe", "x", POLL),  # 85s gap > 15 + 5
    ]
    sessions = list(collapse_samples(rows))
    assert len(sessions) == 2
    assert sessions[0][1] == 1030  # first session credits exactly 2 samples


def test_gap_within_tolerance_merges():
    rows = [
        (1000, "code.exe", "x", POLL),
        (1018, "code.exe", "x", POLL),  # 18s gap <= 15 + 5
    ]
    assert len(list(collapse_samples(rows))) == 1


def test_process_name_lowercased():
    rows = [(1000, "Setup.EXE", "x", POLL)]
    assert list(collapse_samples(rows))[0][2] == "setup.exe"


def test_time_preservation_property():
    """Total session duration == n_samples * poll_rate for gap-free runs."""
    rows = []
    t = 1000
    for block in range(20):
        title = f"page {block % 3}"
        for _ in range(7):
            rows.append((t, "chrome.exe", title, POLL))
            t += 15
    sessions = list(collapse_samples(rows))
    total = sum(end - start for start, end, _, _ in sessions)
    assert total == len(rows) * POLL


# ---------------- split_session_per_day ----------------


def test_split_within_one_day():
    start, end = ts(10), ts(11)
    assert split_session_per_day(start, end) == {"2026-06-15": 3600.0}


def test_split_across_midnight():
    start = ts(23, 59, 0, day=15)
    end = ts(0, 1, 0, day=16)
    out = split_session_per_day(start, end)
    assert out["2026-06-15"] == 60.0
    assert out["2026-06-16"] == 60.0


# ---------------- end-to-end migrate() on a tmp DB ----------------


def _make_legacy_db(path):
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE time_log (
            id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
            process_name TEXT NOT NULL, window_title TEXT, poll_rate REAL NOT NULL)"""
    )
    rows = []
    t = ts(9, 0)
    for i in range(240):  # 1 hour of code.exe
        rows.append((t + i * 15, "code.exe", "main.py", POLL))
    t2 = ts(14, 0)
    for i in range(120):  # 30 min of chrome with a domain-bearing title
        rows.append((t2 + i * 15, "chrome.exe", "Video - https://youtube.com/w", POLL))
    conn.executemany(
        "INSERT INTO time_log (timestamp, process_name, window_title, poll_rate) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()


def test_migrate_end_to_end(tmp_path):
    db_path = tmp_path / "legacy.db"
    _make_legacy_db(db_path)

    stats = migrate(db_path)
    assert stats["n_samples"] == 360
    assert stats["n_sessions"] == 2
    assert stats["max_delta_seconds"] <= 60.0
    assert stats["bad_days"] == {}

    conn = tracker_db.open_db(db_path)
    rows = conn.execute(
        "SELECT process, domain, end_ts - start_ts AS dur FROM sessions"
        " WHERE source='migrated' ORDER BY start_ts"
    ).fetchall()
    assert rows[0]["process"] == "code.exe"
    assert rows[0]["dur"] == 240 * 15
    assert rows[1]["domain"] == "youtube.com"
    # legacy table untouched
    assert conn.execute("SELECT COUNT(*) FROM time_log").fetchone()[0] == 360
    conn.close()


def test_migrate_is_rerunnable(tmp_path):
    db_path = tmp_path / "legacy.db"
    _make_legacy_db(db_path)
    migrate(db_path)
    stats = migrate(db_path)  # second run must not duplicate
    assert stats["n_sessions"] == 2
    conn = sqlite3.connect(db_path)
    n = conn.execute("SELECT COUNT(*) FROM sessions WHERE source='migrated'").fetchone()[0]
    assert n == 2
    conn.close()
