"""Generate a deterministic demo database for screenshots and documentation.

Builds Data/demo.db with several weeks of plausible synthetic sessions (a
software-developer persona: weekday work blocks, lunch breaks, evening gaming
and media, lazier weekends) using the real schema bootstrap from tracker.db,
then adds a clearly synthetic persona's categories and rules. Fresh production
installs deliberately ship without those opinions.

Point a debug dashboard at it with:  TIME_DB_PATH=<repo>/Data/demo.db

Usage:
    py scripts/make_demo_db.py [--out Data/demo.db] [--weeks 12]
                               [--end YYYY-MM-DD] [--force]

The output is regenerated from scratch on every run (the file is marked with a
`demo_dataset` settings key; refusing to overwrite anything unmarked unless
--force). Same arguments -> byte-identical session rows.
"""

from __future__ import annotations

import argparse
import random
import sqlite3
import sys
import time as time_mod
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker.db import open_db  # noqa: E402

SEED = 20260101

# (process, title pool, domain, weight) — domain only set for browser sessions.
CODING = [
    ("code.exe", ["session_manager.py - aurora - Visual Studio Code",
                  "metrics.ts - aurora - Visual Studio Code",
                  "App.tsx - aurora - Visual Studio Code",
                  "db.py - aurora - Visual Studio Code",
                  "README.md - dotfiles - Visual Studio Code"], None, 5.0),
    ("windowsterminal.exe", ["pwsh - aurora", "py -m pytest", "git log"], None, 2.0),
    ("claude.exe", ["Claude Code"], None, 2.0),
    ("chrome.exe", ["python - How do I profile a slow query? - Stack Overflow"],
     "stackoverflow.com", 1.5),
    ("chrome.exe", ["aurora: Pull requests"], "github.com", 1.5),
    ("chrome.exe", ["sqlite3 - DB-API 2.0 interface - Python docs"], "docs.python.org", 1.0),
    ("db browser for sqlite.exe", ["DB Browser for SQLite - demo.db"], None, 0.5),
]
NOTES = [
    ("obsidian.exe", ["Weekly review - vault - Obsidian", "Project ideas - vault - Obsidian"],
     None, 3.0),
    ("notepad.exe", ["scratch.txt - Notepad"], None, 1.0),
    ("chrome.exe", ["Trip planning - Google Docs"], "docs.google.com", 1.5),
]
BROWSE = [
    ("chrome.exe", ["Hacker News"], "news.ycombinator.com", 2.0),
    ("chrome.exe", ["Inbox - Outlook"], "outlook.com", 2.0),
    ("chrome.exe", ["The Weather Channel"], "weather.com", 1.0),
    ("chrome.exe", ["Wikipedia - History of timekeeping"], "wikipedia.org", 1.0),
    ("chrome.exe", ["Amazon.com"], "amazon.com", 1.0),
]
MEDIA = [
    ("chrome.exe", ["lofi hub - radio - YouTube"], "youtube.com", 2.0),
    ("chrome.exe", ["Mechanical watches explained - YouTube"], "youtube.com", 1.5),
    ("chrome.exe", ["Netflix"], "netflix.com", 1.5),
    ("chrome.exe", ["streamer_one - Twitch"], "twitch.tv", 1.0),
    ("chrome.exe", ["r/programming - Reddit"], "reddit.com", 1.5),
]
GAMING = [
    ("rocketleague.exe", ["Rocket League"], None, 2.0),
    ("r5apex_dx12.exe", ["Apex Legends"], None, 2.0),
    ("steam.exe", ["Steam"], None, 0.5),
]
SYSTEM = [
    ("explorer.exe", ["Downloads"], None, 1.0),
    ("searchhost.exe", ["Search"], None, 0.5),
]

# Demo-only taxonomy and rules. These are intentionally kept out of production
# bootstrap so screenshots stay rich without assigning values to real users.
DEMO_CATEGORIES = [
    ("Notes", "#9c8ff0", 1, 0, 1),
    ("Dev", "#2f6fc0", 1, 0, 2),
    ("AI tools", "#43c88a", 1, 0, 3),
    ("Browsing", "#e0a53a", 0, 1, 4),
    ("Gaming", "#e8663d", 0, 1, 5),
    ("Media", "#e75fa0", 0, 0, 6),
    ("System", "#828994", 0, 1, 7),
]

DEMO_RULES = [
    ("process", "obsidian.exe", "Notes", 3),
    ("process", "notepad.exe", "Notes", 3),
    ("process", "code.exe", "Dev", 3),
    ("process", "windowsterminal.exe", "Dev", 3),
    ("process", "db browser for sqlite.exe", "Dev", 3),
    ("process", "claude.exe", "AI tools", 3),
    ("process", "chrome.exe", "Browsing", 3),
    ("process", "rocketleague.exe", "Gaming", 3),
    ("process", "r5apex_dx12.exe", "Gaming", 3),
    ("process", "steam.exe", "Gaming", 3),
    ("process", "explorer.exe", "System", 3),
    ("process", "searchhost.exe", "System", 3),
    ("domain", "github.com", "Dev", 1),
    ("domain", "stackoverflow.com", "Dev", 1),
    ("domain", "docs.python.org", "Dev", 1),
    ("domain", "docs.google.com", "Notes", 1),
    ("domain", "youtube.com", "Media", 1),
    ("domain", "netflix.com", "Media", 1),
    ("domain", "twitch.tv", "Media", 1),
    ("domain", "reddit.com", "Media", 1),
]

# Mix = weighted activity pools a block draws from.
WORK_MIX = [(CODING, 70), (NOTES, 10), (BROWSE, 12), (SYSTEM, 4), (MEDIA, 4)]
EVENING_MIX = [(MEDIA, 40), (GAMING, 35), (NOTES, 10), (BROWSE, 10), (CODING, 5)]
WEEKEND_MIX = [(GAMING, 35), (MEDIA, 30), (BROWSE, 15), (CODING, 12), (NOTES, 8)]


def _pick(rng: random.Random, mix):
    pools, weights = zip(*mix)
    pool = rng.choices(pools, weights=weights)[0]
    process, titles, domain, _w = rng.choices(pool, weights=[e[3] for e in pool])[0]
    return process, rng.choice(titles), domain


def _block(rng, rows, start: float, end: float, mix, mean_min: float) -> None:
    """Fill [start, end) with contiguous app sessions drawn from `mix`."""
    cur = start
    while cur < end - 60:
        dur = min(rng.lognormvariate(0, 0.6) * mean_min * 60, end - cur)
        dur = max(45.0, dur)
        process, title, domain = _pick(rng, mix)
        rows.append((int(cur), int(min(cur + dur, end)), process, title, domain, 0))
        cur += dur


def _afk(rows, start: float, minutes: float, reason: str = "idle") -> float:
    end = start + minutes * 60
    rows.append((int(start), int(end), "afk", reason, None, 1))
    return end


def _day_sessions(rng: random.Random, day: datetime, recency: float) -> list:
    """One day of sessions. recency in [0,1]: 1 = most recent week (more
    coding, less gaming) so Trends and per-app deltas have a visible story."""
    rows: list = []
    weekday = day.weekday() < 5  # Mon-Fri
    base = day.timestamp()

    work_mix = [(p, w * (1 + 0.5 * recency) if p is CODING else w) for p, w in WORK_MIX]
    fun_mix = [(p, w * (1.4 - 0.6 * recency) if p is GAMING else w)
               for p, w in (EVENING_MIX if weekday else WEEKEND_MIX)]

    if weekday:
        t = base + rng.uniform(8.25, 9.5) * 3600
        morning_end = base + rng.uniform(11.9, 12.7) * 3600
        _block(rng, rows, t, t + rng.uniform(15, 35) * 60, [(BROWSE, 80), (NOTES, 20)], 6)
        _block(rng, rows, rows[-1][1], morning_end, work_mix, 14)
        t = _afk(rows, morning_end, rng.uniform(30, 60))  # lunch
        afternoon_end = base + rng.uniform(16.5, 17.8) * 3600
        coffee = t + rng.uniform(1.0, 2.5) * 3600
        _block(rng, rows, t, coffee, work_mix, 16)
        t = _afk(rows, coffee, rng.uniform(5, 18))
        _block(rng, rows, t, afternoon_end, work_mix, 12)
        if rng.random() < 0.7:  # most evenings back at the PC
            t = base + rng.uniform(18.7, 19.8) * 3600
            night_end = base + rng.uniform(20.8, 22.6) * 3600
            _block(rng, rows, t, night_end, fun_mix, 22)
    else:
        t = base + rng.uniform(9.5, 11.2) * 3600
        _block(rng, rows, t, t + rng.uniform(25, 50) * 60, [(BROWSE, 70), (MEDIA, 30)], 8)
        t = rows[-1][1]
        midday_end = base + rng.uniform(12.5, 13.5) * 3600
        _block(rng, rows, t, midday_end, fun_mix, 18)
        t = _afk(rows, midday_end, rng.uniform(45, 120), "idle")
        if rng.random() < 0.6:  # weekend afternoon hobby block
            _block(rng, rows, t, t + rng.uniform(1.2, 2.5) * 3600, work_mix, 15)
            t = rows[-1][1]
        if rng.random() < 0.85:
            t = max(t, base + rng.uniform(19.0, 20.0) * 3600)
            _block(rng, rows, t, base + rng.uniform(21.3, 23.0) * 3600, fun_mix, 25)
    return rows


def generate(out: Path, weeks: int, end_day: datetime, now_ts: int | None) -> int:
    rng = random.Random(SEED)
    days = weeks * 7
    rows: list = []
    for i in range(days):
        day = end_day - timedelta(days=days - 1 - i)
        recency = i / max(days - 1, 1)
        rows.extend(_day_sessions(rng, day, recency))

    if now_ts is not None:  # truncate "today" at now and end on an open live
        rows = [r for r in rows if r[0] < now_ts]  # session so the dashboard
        rows = [(s, min(e, now_ts), p, t, d, a) for s, e, p, t, d, a in rows]
        last_end = rows[-1][1] if rows else now_ts - 1800
        start = max(last_end, now_ts - 1500)
        if start < now_ts:
            rows.append((start, now_ts, "code.exe",
                         "metrics.ts - aurora - Visual Studio Code", None, 0))

    conn = open_db(out)
    try:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_dataset','1')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('recording_consent','1')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('record_window_titles','1')")
        # The persona's productive hours land around 35-40/wk; match the goal.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('weekly_goal_hours','35')"
        )
        conn.executemany(
            "INSERT OR IGNORE INTO categories"
            " (name,color,is_productive,is_neutral,sort_order) VALUES (?,?,?,?,?)",
            DEMO_CATEGORIES,
        )
        cat_ids = {r[1]: r[0] for r in conn.execute("SELECT id, name FROM categories")}
        conn.executemany(
            "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES (?,?,?,?)",
            [(mt, pat, cat_ids[cat], prio) for mt, pat, cat, prio in DEMO_RULES],
        )
        conn.executemany(
            "INSERT INTO sessions (start_ts, end_ts, process, title, domain, is_afk, source)"
            " VALUES (?,?,?,?,?,?,'live')",
            rows,
        )
    finally:
        conn.close()
    return len(rows)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(root / "Data" / "demo.db"))
    ap.add_argument("--weeks", type=int, default=12)
    ap.add_argument("--end", help="last day (YYYY-MM-DD); default today, truncated at 'now'")
    ap.add_argument("--force", action="store_true", help="overwrite an unmarked existing file")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    if out.name == "time_log.db":
        print("refusing to write the real tracker database (time_log.db)")
        return 1
    if out.exists() and not args.force:
        try:
            with sqlite3.connect(out) as check:
                marked = check.execute(
                    "SELECT value FROM settings WHERE key='demo_dataset'"
                ).fetchone()
        except sqlite3.Error:
            marked = None
        if not marked:
            print(f"{out} exists and is not a demo dataset; pass --force to overwrite")
            return 1
    try:
        for suffix in ("", "-wal", "-shm"):
            Path(str(out) + suffix).unlink(missing_ok=True)
    except PermissionError:
        # Cloud-sync filter drivers (e.g. Google Drive) can hold the file open
        # without blocking writes; fall back to wiping tables in place.
        with sqlite3.connect(out) as conn:
            for table in ("sessions", "rules", "categories", "settings"):
                try:
                    conn.execute(f"DELETE FROM {table}")
                except sqlite3.OperationalError:
                    pass  # table absent in an older/partial file

    if args.end:
        end_day = datetime.strptime(args.end, "%Y-%m-%d")
        now_ts = None
    else:
        end_day = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        now_ts = int(time_mod.time())

    n = generate(out, args.weeks, end_day, now_ts)
    print(f"wrote {n} sessions over {args.weeks} weeks -> {out}")
    print(f"point a debug dashboard at it: TIME_DB_PATH={out.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
