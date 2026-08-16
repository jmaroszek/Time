"""Content and safety contracts for the generated screenshot dataset."""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from statistics import quantiles

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from make_demo_db import APP_SPECS, PROCESS_ALIASES, WEBSITES, generate

END = datetime(2026, 6, 7)  # A completed Sunday keeps week comparisons exact.
WEEKS = 12
TOP_APPS = [
    "Google Chrome",
    "Microsoft Word",
    "Outlook",
    "Spotify",
    "Microsoft Excel",
    "Zoom",
    "Adobe Photoshop",
    "Discord",
    "Steam",
    "File Explorer",
]


def _make(path: Path) -> sqlite3.Connection:
    n = generate(path, WEEKS, END, now_ts=None)
    assert n > 0
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture(scope="module")
def conn(tmp_path_factory: pytest.TempPathFactory):
    db = _make(tmp_path_factory.mktemp("demo") / "demo.db")
    yield db
    db.close()


def _week_bounds() -> tuple[datetime, datetime, datetime]:
    current = END - timedelta(days=END.weekday())
    return current - timedelta(days=7), current, current + timedelta(days=7)


def _app_totals(conn: sqlite3.Connection, start: datetime, end: datetime) -> dict[str, int]:
    return {
        row["process"]: row["seconds"]
        for row in conn.execute(
            "SELECT process, SUM(end_ts-start_ts) AS seconds FROM sessions"
            " WHERE is_afk=0 AND start_ts>=? AND end_ts<=? GROUP BY process",
            (start.timestamp(), end.timestamp()),
        )
    }


def _daily_app_seconds(
    conn: sqlite3.Connection,
    process: str,
    start: datetime,
) -> list[int]:
    values = []
    for offset in range(7):
        day = start + timedelta(days=offset)
        row = conn.execute(
            "SELECT COALESCE(SUM(end_ts-start_ts),0) FROM sessions"
            " WHERE is_afk=0 AND process=? AND start_ts>=? AND end_ts<=?",
            (process, day.timestamp(), (day + timedelta(days=1)).timestamp()),
        ).fetchone()
        values.append(int(row[0]))
    return values


def _robust_fraction(current: list[int], previous: list[int]) -> float:
    worst = max(range(7), key=lambda index: abs(current[index] - previous[index]))
    delta = sum(current[index] - previous[index] for index in range(7) if index != worst)
    baseline = sum(previous[index] for index in range(7) if index != worst)
    return delta / baseline


def _rule_maps(conn: sqlite3.Connection):
    rows = conn.execute(
        "SELECT r.match_type,r.pattern,c.name,c.is_productive,c.is_neutral,c.is_ignored"
        " FROM rules r JOIN categories c ON c.id=r.category_id"
    ).fetchall()
    return {
        match_type: {
            row["pattern"]: (row["name"], row["is_productive"], row["is_neutral"], row["is_ignored"])
            for row in rows
            if row["match_type"] == match_type
        }
        for match_type in ("process", "domain")
    }


def _daily_hours(conn: sqlite3.Connection):
    rules = _rule_maps(conn)
    first = END - timedelta(days=WEEKS * 7 - 1)
    days = [first + timedelta(days=index) for index in range(WEEKS * 7)]
    totals = {day.date(): 0.0 for day in days}
    productive = {day.date(): 0.0 for day in days}
    for row in conn.execute(
        "SELECT start_ts,end_ts,process,domain FROM sessions WHERE is_afk=0 ORDER BY start_ts"
    ):
        day = datetime.fromtimestamp(row["start_ts"]).date()
        seconds = row["end_ts"] - row["start_ts"]
        totals[day] += seconds / 3600
        category = rules["domain"].get(row["domain"]) or rules["process"][row["process"]]
        if category[1] and not category[3]:
            productive[day] += seconds / 3600
    return days, totals, productive


def test_deterministic(tmp_path):
    a = _make(tmp_path / "a.db")
    b = _make(tmp_path / "b.db")
    rows = "SELECT start_ts,end_ts,process,title,domain,is_afk FROM sessions ORDER BY id"
    assert a.execute(rows).fetchall() == b.execute(rows).fetchall()
    a.close()
    b.close()


def test_sessions_well_formed_and_non_overlapping(conn):
    rows = conn.execute(
        "SELECT start_ts,end_ts,is_afk FROM sessions ORDER BY start_ts"
    ).fetchall()
    previous_end = 0
    for row in rows:
        assert row["end_ts"] > row["start_ts"]
        assert row["start_ts"] >= previous_end
        previous_end = row["end_ts"]


def test_uses_exact_shipped_category_set(conn):
    categories = conn.execute(
        "SELECT name,is_productive,is_neutral,is_ignored FROM categories ORDER BY sort_order,id"
    ).fetchall()
    assert [tuple(row) for row in categories] == [
        ("Work", 1, 0, 0),
        ("Communication", 0, 1, 0),
        ("Browsing", 0, 1, 0),
        ("Entertainment", 0, 0, 0),
        ("System", 0, 1, 0),
        ("Ignored", 0, 0, 1),
    ]


def test_aliases_marker_and_screenshot_settings_present(conn):
    settings = dict(conn.execute(
        "SELECT key,value FROM settings WHERE key IN"
        " ('demo_dataset','process_aliases','starter_categories_pending','weekly_goal_hours')"
    ))
    assert settings["demo_dataset"] == "1"
    assert settings["starter_categories_pending"] == "0"
    assert settings["weekly_goal_hours"] == "15"
    assert json.loads(settings["process_aliases"]) == PROCESS_ALIASES


def test_top_apps_are_exact_recognizable_order(conn):
    _previous, current, end = _week_bounds()
    totals = _app_totals(conn, current, end)
    ranked = sorted(totals, key=lambda process: (-totals[process], PROCESS_ALIASES[process]))
    assert [PROCESS_ALIASES[process] for process in ranked] == TOP_APPS
    assert set(ranked) == set(APP_SPECS)


def test_recent_changes_clear_real_dashboard_gates(conn):
    previous, current, end = _week_bounds()
    previous_totals = _app_totals(conn, previous, current)
    current_totals = _app_totals(conn, current, end)

    expected = {
        "winword.exe": (1, "good"),
        "photoshop.exe": (1, "good"),
        "steam.exe": (-1, "good"),
        "spotify.exe": (1, "bad"),
    }
    for process, (sign, _direction) in expected.items():
        delta = (current_totals[process] - previous_totals[process]) / previous_totals[process]
        current_daily = _daily_app_seconds(conn, process, current)
        previous_daily = _daily_app_seconds(conn, process, previous)
        robust = _robust_fraction(current_daily, previous_daily)
        assert delta * sign >= 0.25
        assert robust * sign >= 0.15
        assert abs(current_totals[process] - previous_totals[process]) >= 4 * 60 * 7
        assert sum(value > 0 for value in current_daily) >= 2

    for process in set(APP_SPECS) - set(expected):
        delta = (current_totals[process] - previous_totals[process]) / previous_totals[process]
        assert abs(delta) < 0.25


def test_browser_coverage_and_generic_websites(conn):
    bad = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE domain IS NOT NULL AND process!='chrome.exe'"
    ).fetchone()[0]
    missing = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE process='chrome.exe' AND domain IS NULL"
    ).fetchone()[0]
    domains = {
        row[0] for row in conn.execute(
            "SELECT DISTINCT domain FROM sessions WHERE process='chrome.exe'"
        )
    }
    assert bad == 0
    assert missing == 0
    assert domains == {website.domain for website in WEBSITES}


def test_all_apps_classify_and_afk_is_valid(conn):
    unmatched = conn.execute(
        "SELECT DISTINCT process FROM sessions WHERE is_afk=0 AND process NOT IN"
        " (SELECT pattern FROM rules WHERE match_type='process')"
    ).fetchall()
    mismarked = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE (process='afk')!=(is_afk=1)"
    ).fetchone()[0]
    afk = conn.execute("SELECT COUNT(*) FROM sessions WHERE is_afk=1").fetchone()[0]
    assert unmatched == []
    assert mismarked == 0
    assert afk >= WEEKS * 3


def test_daily_totals_have_visible_but_credible_variance(conn):
    days, totals, productive = _daily_hours(conn)
    values = [totals[day.date()] for day in days]
    p10, *_, p90 = quantiles(values, n=10, method="inclusive")
    off_fraction = sum(value == 0 for value in values) / len(values)
    assert p90 - p10 >= 4.0
    assert 0.08 <= off_fraction <= 0.15

    _previous, current, _end = _week_bounds()
    current_weekdays = [(current + timedelta(days=index)).date() for index in range(5)]
    assert max(totals[day] for day in current_weekdays) - min(
        totals[day] for day in current_weekdays
    ) >= 3.0
    assert max(productive[day] for day in current_weekdays) - min(
        productive[day] for day in current_weekdays
    ) >= 2.5

    productive_values = [productive[day.date()] for day in days]
    rolling = [sum(productive_values[index - 6:index + 1]) / 7 for index in range(6, len(days))]
    assert max(rolling[-28:]) - min(rolling[-28:]) >= 0.75


def test_no_retired_developer_or_owner_specific_content(conn):
    content = " ".join(
        " ".join(str(value or "") for value in row)
        for row in conn.execute("SELECT process,title,domain FROM sessions")
    ).lower()
    for retired in (
        "claude", "windowsterminal", "obsidian", "db browser", "apex",
        "aurora", "python", "github", "visual studio code",
    ):
        assert retired not in content
