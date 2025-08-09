#!/usr/bin/env python3
"""
time_analysis.py
Utilities for querying the SQLite log and aggregating usage / productivity.
All aggregation uses the SAME classification rules so totals and averages align.
"""

from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta

import config

# ----------------- Date helpers -----------------

_DATE_FMT = "%m/%d/%y"


def parse_date(date_str: str) -> datetime:
    """Parse a date string in MM/DD/YY format as a naive local datetime at 00:00."""
    return datetime.strptime(date_str, _DATE_FMT)


def _start_of_week(dt: datetime) -> datetime:
    """Return the start of the week (00:00 local) given WEEK_START in config."""
    # Map WEEK_START to weekday index where Monday=0 ... Sunday=6 (Python convention)
    start_name = getattr(config, "WEEK_START", "Sunday")
    start_index = {"Monday": 0, "Sunday": 6}.get(start_name, 6)
    # dt.weekday(): Monday=0 ... Sunday=6
    delta_days = (dt.weekday() - start_index) % 7
    start = (dt - timedelta(days=delta_days)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return start


def get_timestamp_bounds(start_str: str, end_str: str) -> tuple[float, float]:
    """
    Convert UI date strings to half‑open UNIX timestamp bounds [start, end).
    The end bound is the midnight *after* the end date.
    """
    start_dt = parse_date(start_str)
    end_dt = parse_date(end_str) + timedelta(days=1)
    return start_dt.timestamp(), end_dt.timestamp()


def get_this_weeks_bounds(now: datetime | None = None) -> tuple[float, float]:
    """Bounds for [start_of_week, tomorrow) using local time."""
    now = now or datetime.now()
    start = _start_of_week(now)
    end = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return start.timestamp(), end.timestamp()


def get_last_weeks_bounds(now: datetime | None = None) -> tuple[float, float]:
    """Bounds for the previous full week (7 days) based on WEEK_START."""
    now = now or datetime.now()
    this_start = _start_of_week(now)
    last_start = this_start - timedelta(days=7)
    last_end = this_start
    return last_start.timestamp(), last_end.timestamp()


def get_last_n_weeks_bounds(n: int, now: datetime | None = None) -> tuple[float, float]:
    """
    Bounds for the last n full weeks (not including the current partial week).
    For n=2 and week starting Sunday, this returns the 14 days before this Sunday.
    """
    now = now or datetime.now()
    this_start = _start_of_week(now)
    start = this_start - timedelta(days=7 * n)
    end = this_start
    return start.timestamp(), end.timestamp()


# ----------------- Query helpers -----------------


def get_total_use(
    conn: sqlite3.Connection, start_ts: float, end_ts: float
) -> list[tuple[str, float]]:
    """
    Sum seconds per process between [start_ts, end_ts) ordered descending.
    """
    query = """
        SELECT process_name, SUM(poll_rate) AS total_seconds
        FROM time_log
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY process_name
        ORDER BY total_seconds DESC;
    """
    cur = conn.cursor()
    cur.execute(query, (int(start_ts), int(end_ts)))
    rows = [(row[0], float(row[1])) for row in cur.fetchall()]
    return rows


def get_daily_use(
    conn: sqlite3.Connection, start_ts: float, end_ts: float
) -> dict[str, list[tuple[str, str, float]]]:
    """
    Return a dict keyed by date string (MM/DD/YY) -> list of (process_name, window_title, seconds)
    for each day in [start_ts, end_ts).
    """
    query = """
        SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch') AS day,
               process_name,
               COALESCE(window_title, '') AS window_title,
               SUM(poll_rate) AS total_seconds
        FROM time_log
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY day, process_name, window_title
        ORDER BY day ASC, total_seconds DESC;
    """
    cur = conn.cursor()
    cur.execute(query, (int(start_ts), int(end_ts)))
    out: dict[str, list[tuple[str, str, float]]] = defaultdict(list)
    for day, proc, title, secs in cur.fetchall():
        out[day].append((proc, title, float(secs)))
    return dict(out)


# ----------------- Classification & aggregation -----------------

# Precompute normalization and patterns
_PRODUCTIVE = {p.lower() for p in getattr(config, "PRODUCTIVE_APPS", [])}
# treat browsers uniformly
_BROWSER_PROCS = {"chrome.exe", "thorium.exe"}
# compile unproductive title patterns (simple contains, compiled for speed)
_UNPROD_PATTERNS = [
    re.compile(re.escape(pat), re.IGNORECASE)
    for pat in getattr(config, "UNPRODUCTIVE_CHROME_KEYWORDS", set())
]


def _title_is_unproductive(title: str) -> bool:
    if not title:
        return False
    return any(p.search(title) for p in _UNPROD_PATTERNS)


def get_daily_productivity(
    daily_usage: dict[str, list[tuple[str, str, float]]],
) -> dict[str, dict[str, float]]:
    """
    Collapse per-window usage into daily 'Productive' / 'Non-Productive' seconds.

    Rules:
      - Process not in PRODUCTIVE_APPS  -> Non-Productive
      - Process in PRODUCTIVE_APPS but is a browser:
           title matches UNPRODUCTIVE_CHROME_KEYWORDS -> Non-Productive
           otherwise                                   -> Productive
      - Other PRODUCTIVE_APPS -> Productive
    """
    out: dict[str, dict[str, float]] = {}
    for day, entries in daily_usage.items():
        prod = 0.0
        nonprod = 0.0
        for proc, title, secs in entries:
            proc_l = (proc or "").lower()
            if proc_l in _PRODUCTIVE:
                if proc_l in _BROWSER_PROCS and _title_is_unproductive(title or ""):
                    nonprod += secs
                else:
                    prod += secs
            else:
                nonprod += secs
        out[day] = {"Productive": prod, "Non-Productive": nonprod}
    return out


def get_interval_stats(
    total_use: list[tuple[str, float]], daily_productivity: dict[str, dict[str, float]]
) -> dict[str, float]:
    """
    Compute totals and per-day averages from the SAME classification (daily_productivity).
    """
    n_days = len(daily_productivity)
    sum_prod = sum(d.get("Productive", 0.0) for d in daily_productivity.values())
    sum_non = sum(d.get("Non-Productive", 0.0) for d in daily_productivity.values())

    total_prod = sum_prod
    total_non = sum_non
    total_time = total_prod + total_non

    avg_prod = (sum_prod / n_days) if n_days else 0.0
    avg_non = (sum_non / n_days) if n_days else 0.0

    ratio = (total_prod / total_non) if total_non > 0 else float("inf")

    return {
        "total_time": total_time,
        "total_prod": total_prod,
        "total_nonprod": total_non,
        "avg_prod_per_day": avg_prod,
        "avg_nonprod_per_day": avg_non,
        "ratio": ratio,
        "n_days": n_days,
    }


# ----------------- Formatting helpers (used by plots/UI) -----------------


def format_duration(seconds: float) -> str:
    """Convert seconds to H:MM:SS string."""
    return str(timedelta(seconds=round(seconds)))


def clean_process_name(process_name: str, max_len: int = 15) -> str:
    """Shorten/normalize some noisy executable names for plotting."""
    if process_name == "r5apex_dx12.exe":
        process_name = "apex"
    name = process_name.capitalize().removesuffix(".exe")
    return name if len(name) <= max_len else (name[:max_len] + "...")
