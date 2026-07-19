"""Invariants of the generated demo dataset (tmp DB, fixed --end date)."""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_demo_db import generate

END = datetime(2026, 6, 5)  # a Friday
WEEKS = 2


def _make(tmp_path: Path, name: str = "demo.db") -> sqlite3.Connection:
    out = tmp_path / name
    n = generate(out, WEEKS, END, now_ts=None)
    assert n > 0
    conn = sqlite3.connect(out)
    conn.row_factory = sqlite3.Row
    return conn


def test_deterministic(tmp_path):
    a = _make(tmp_path, "a.db")
    b = _make(tmp_path, "b.db")
    rows = "SELECT start_ts, end_ts, process, title, domain, is_afk FROM sessions ORDER BY id"
    assert a.execute(rows).fetchall() == b.execute(rows).fetchall()


def test_sessions_well_formed_and_non_overlapping(tmp_path):
    conn = _make(tmp_path)
    rows = conn.execute(
        "SELECT start_ts, end_ts, is_afk FROM sessions ORDER BY start_ts"
    ).fetchall()
    prev_end = 0
    for r in rows:
        assert r["end_ts"] > r["start_ts"]
        assert r["start_ts"] >= prev_end
        prev_end = r["end_ts"]


def test_covers_every_day_in_range(tmp_path):
    conn = _make(tmp_path)
    days = conn.execute(
        "SELECT COUNT(DISTINCT date(start_ts, 'unixepoch', 'localtime')) AS n FROM sessions"
    ).fetchone()["n"]
    assert days == WEEKS * 7


def test_domains_only_on_browser_sessions(tmp_path):
    conn = _make(tmp_path)
    bad = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE domain IS NOT NULL AND process != 'chrome.exe'"
    ).fetchone()[0]
    assert bad == 0
    some = conn.execute("SELECT COUNT(*) FROM sessions WHERE domain IS NOT NULL").fetchone()[0]
    assert some > 50


def test_afk_sessions_present_and_marked(tmp_path):
    conn = _make(tmp_path)
    afk = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE is_afk = 1 AND process = 'afk'"
    ).fetchone()[0]
    assert afk >= WEEKS * 5  # at least lunch breaks on weekdays
    mismarked = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE (process = 'afk') != (is_afk = 1)"
    ).fetchone()[0]
    assert mismarked == 0


def test_seeds_and_marker_present(tmp_path):
    conn = _make(tmp_path)
    assert conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] >= 8
    assert conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] >= 20
    marker = conn.execute(
        "SELECT value FROM settings WHERE key = 'demo_dataset'"
    ).fetchone()
    assert marker is not None and marker[0] == "1"


def test_all_processes_match_a_seed_rule(tmp_path):
    """Every non-AFK process in the demo data classifies via seed rules, so the
    dashboard shows no 'uncategorized' noise in screenshots."""
    conn = _make(tmp_path)
    unmatched = conn.execute(
        "SELECT DISTINCT process FROM sessions WHERE is_afk = 0 AND process NOT IN"
        " (SELECT pattern FROM rules WHERE match_type = 'process')"
    ).fetchall()
    assert [r["process"] for r in unmatched] == []
