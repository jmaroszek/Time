"""Generate a deterministic demo database for screenshots and documentation.

Builds data/demo.db with several weeks of plausible synthetic sessions for a
broadly relatable work-and-personal Windows profile. The history uses the real
schema bootstrap from tracker.db, the shipped starter categories, and generic
app/site names rather than borrowing a real person's activity.

Point a debug dashboard at it with:  TIME_DB_PATH=<repo>/data/demo.db

Usage:
    py scripts/make_demo_db.py [--out data/demo.db] [--weeks 12]
                               [--end YYYY-MM-DD] [--force]

The output is regenerated from scratch on every run (the file is marked with a
`demo_dataset` settings key; refusing to overwrite anything unmarked unless
--force). Same arguments -> byte-identical session rows.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sqlite3
import sys
import time as time_mod
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker.db import open_db  # noqa: E402

SEED = 20260101


@dataclass(frozen=True)
class AppSpec:
    display_name: str
    category: str
    titles: tuple[str, ...]


@dataclass(frozen=True)
class WebsiteSpec:
    domain: str
    display_name: str
    category: str
    titles: tuple[str, ...]
    weight: float


# Order is the intended current-week Top Apps ranking. Aliases make the labels
# part of the synthetic profile rather than teaching production code to guess
# friendly names from executable filenames.
APP_SPECS = {
    "chrome.exe": AppSpec("Google Chrome", "Browsing", ()),
    "winword.exe": AppSpec(
        "Microsoft Word",
        "Work",
        (
            "Project proposal - Microsoft Word",
            "Meeting notes - Microsoft Word",
            "Quarterly report - Microsoft Word",
        ),
    ),
    "outlook.exe": AppSpec(
        "Outlook",
        "Communication",
        ("Inbox - Outlook", "Calendar - Outlook", "Sent Items - Outlook"),
    ),
    "spotify.exe": AppSpec(
        "Spotify",
        "Entertainment",
        ("Discover Weekly - Spotify", "Daily Mix - Spotify", "Focus playlist - Spotify"),
    ),
    "excel.exe": AppSpec(
        "Microsoft Excel",
        "Work",
        ("Monthly budget - Microsoft Excel", "Project tracker - Microsoft Excel"),
    ),
    "zoom.exe": AppSpec(
        "Zoom",
        "Communication",
        ("Zoom Meeting", "Team check-in - Zoom"),
    ),
    "photoshop.exe": AppSpec(
        "Adobe Photoshop",
        "Work",
        ("Website banner.psd - Adobe Photoshop", "Product photo edit - Adobe Photoshop"),
    ),
    "discord.exe": AppSpec(
        "Discord",
        "Communication",
        ("Friends - Discord", "General - Discord"),
    ),
    "steam.exe": AppSpec(
        "Steam",
        "Entertainment",
        ("Steam Library", "Steam"),
    ),
    "explorer.exe": AppSpec(
        "File Explorer",
        "System",
        ("Documents - File Explorer", "Downloads - File Explorer"),
    ),
}

WEBSITES = (
    WebsiteSpec("google.com", "Google", "Browsing", ("Google Search",), 17),
    WebsiteSpec("mail.google.com", "Gmail", "Communication", ("Inbox - Gmail",), 12),
    WebsiteSpec("docs.google.com", "Google Docs", "Work", ("Shared document - Google Docs",), 16),
    WebsiteSpec("youtube.com", "YouTube", "Entertainment", ("YouTube", "Music video - YouTube"), 15),
    WebsiteSpec("amazon.com", "Amazon", "Browsing", ("Amazon.com",), 8),
    WebsiteSpec("wikipedia.org", "Wikipedia", "Browsing", ("Wikipedia",), 8),
    WebsiteSpec("reddit.com", "Reddit", "Entertainment", ("Popular - Reddit",), 8),
    WebsiteSpec("netflix.com", "Netflix", "Entertainment", ("Netflix",), 6),
    WebsiteSpec("canva.com", "Canva", "Work", ("Social graphic - Canva",), 6),
    WebsiteSpec("weather.com", "Weather", "Browsing", ("Local weather",), 4),
)

PROCESS_ALIASES = {
    **{process: spec.display_name for process, spec in APP_SPECS.items()},
    **{website.domain: website.display_name for website in WEBSITES},
}

DEMO_RULES = [
    *(("process", process, spec.category, 3) for process, spec in APP_SPECS.items()),
    *(("domain", website.domain, website.category, 1) for website in WEBSITES),
]

# Historical profiles: app-share percentages within a day's active total.
# Productive shares deliberately differ so the heatmap and rolling average tell
# a story instead of rendering the same workday at slightly different lengths.
PROFILE_WEIGHTS = {
    "deep": {
        "chrome.exe": 13, "winword.exe": 30, "outlook.exe": 5,
        "spotify.exe": 3, "excel.exe": 20, "zoom.exe": 3,
        "photoshop.exe": 17, "discord.exe": 1, "steam.exe": 1,
        "explorer.exe": 7,
    },
    "standard": {
        "chrome.exe": 15, "winword.exe": 30, "outlook.exe": 7,
        "spotify.exe": 5, "excel.exe": 18, "zoom.exe": 4,
        "photoshop.exe": 12, "discord.exe": 2, "steam.exe": 2,
        "explorer.exe": 5,
    },
    "communication": {
        "chrome.exe": 15, "winword.exe": 18, "outlook.exe": 20,
        "spotify.exe": 5, "excel.exe": 14, "zoom.exe": 12,
        "photoshop.exe": 8, "discord.exe": 4, "steam.exe": 1,
        "explorer.exe": 3,
    },
    "light": {
        "chrome.exe": 20, "winword.exe": 22, "outlook.exe": 10,
        "spotify.exe": 10, "excel.exe": 14, "zoom.exe": 6,
        "photoshop.exe": 9, "discord.exe": 5, "steam.exe": 2,
        "explorer.exe": 2,
    },
    "weekend": {
        "chrome.exe": 25, "winword.exe": 8, "outlook.exe": 5,
        "spotify.exe": 18, "excel.exe": 4, "zoom.exe": 2,
        "photoshop.exe": 3, "discord.exe": 12, "steam.exe": 20,
        "explorer.exe": 3,
    },
}

PROFILE_HOURS = {
    "deep": (8.5, 9.5),
    "standard": (6.5, 8.0),
    "communication": (5.5, 7.0),
    "light": (3.0, 5.0),
    "weekend": (1.0, 4.0),
}

# The current and previous weeks are a controlled comparison pair. These totals
# remain believable, preserve the requested ranking, and clear the dashboard's
# real delta gates without any chart-specific fixture or UI shortcut.
CURRENT_WEEK_HOURS = {
    "chrome.exe": 11.5,
    "winword.exe": 8.0,
    "outlook.exe": 5.5,
    "spotify.exe": 4.0,
    "excel.exe": 3.5,
    "zoom.exe": 3.0,
    "photoshop.exe": 2.6,
    "discord.exe": 2.0,
    "steam.exe": 1.5,
    "explorer.exe": 1.0,
}

PREVIOUS_WEEK_HOURS = {
    "chrome.exe": 12.0,
    "winword.exe": 5.7,
    "outlook.exe": 5.2,
    "spotify.exe": 2.86,
    "excel.exe": 3.3,
    "zoom.exe": 2.8,
    "photoshop.exe": 1.73,
    "discord.exe": 1.9,
    "steam.exe": 2.31,
    "explorer.exe": 0.95,
}

DAY_SHARES = {
    "chrome.exe": (0.14, 0.20, 0.10, 0.20, 0.14, 0.12, 0.10),
    "winword.exe": (0.17, 0.29, 0.10, 0.27, 0.17, 0.00, 0.00),
    "outlook.exe": (0.16, 0.28, 0.12, 0.28, 0.16, 0.00, 0.00),
    "spotify.exe": (0.13, 0.18, 0.11, 0.18, 0.13, 0.14, 0.13),
    "excel.exe": (0.17, 0.29, 0.10, 0.27, 0.17, 0.00, 0.00),
    "zoom.exe": (0.16, 0.28, 0.12, 0.28, 0.16, 0.00, 0.00),
    "photoshop.exe": (0.17, 0.29, 0.10, 0.27, 0.17, 0.00, 0.00),
    "discord.exe": (0.11, 0.13, 0.10, 0.13, 0.11, 0.22, 0.20),
    "steam.exe": (0.00, 0.00, 0.08, 0.00, 0.08, 0.42, 0.42),
    "explorer.exe": (0.15, 0.25, 0.10, 0.25, 0.15, 0.05, 0.05),
}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _recent_targets(day: datetime, weekly_hours: dict[str, float]) -> dict[str, float]:
    weekday = day.weekday()
    return {
        process: hours * DAY_SHARES[process][weekday]
        for process, hours in weekly_hours.items()
        if hours * DAY_SHARES[process][weekday] > 0
    }


def _historical_targets(
    rng: random.Random,
    day: datetime,
    week_index: int,
) -> dict[str, float]:
    weekday = day.weekday() < 5
    if weekday:
        # Roughly five percent of weekdays and a quarter of weekends are truly
        # off. Across a mature history that produces the blank heatmap cells a
        # real computer record has without making the profile look abandoned.
        if rng.random() < 0.05:
            return {}
        profile = rng.choices(
            ("deep", "standard", "communication", "light"),
            weights=(22, 43, 20, 15),
        )[0]
    else:
        if rng.random() < 0.25:
            return {}
        profile = "weekend" if rng.random() < 0.85 else "light"

    low, high = PROFILE_HOURS[profile]
    wave = 0.5 + 0.27 * math.sin((week_index + 1) * 1.37) + rng.uniform(-0.2, 0.2)
    total_hours = low + (high - low) * _clamp(wave, 0.0, 1.0)

    weights: dict[str, float] = {}
    for process, weight in PROFILE_WEIGHTS[profile].items():
        # Small destinations do not need to appear every day. Removing some of
        # them before normalization gives the Activity view realistic absences.
        if weight <= 4 and rng.random() < 0.38:
            continue
        weights[process] = weight * rng.uniform(0.82, 1.18)
    scale = total_hours / sum(weights.values())
    return {process: weight * scale for process, weight in weights.items()}


def _website_pick(rng: random.Random) -> WebsiteSpec:
    return rng.choices(WEBSITES, weights=[website.weight for website in WEBSITES])[0]


def _activity_chunks(
    rng: random.Random,
    targets: dict[str, float],
) -> list[tuple[str, str, str | None, int]]:
    chunks: list[tuple[str, str, str | None, int, float]] = []
    for process, hours in targets.items():
        remaining = int(round(hours * 3600))
        while remaining > 0:
            seconds = min(remaining, int(rng.uniform(7, 34) * 60))
            if process == "chrome.exe":
                website = _website_pick(rng)
                title = rng.choice(website.titles)
                domain = website.domain
            else:
                spec = APP_SPECS[process]
                title = rng.choice(spec.titles)
                domain = None
            # Entertainment naturally clusters later while work and browsing
            # remain interleaved. Random jitter prevents category stripes.
            phase = rng.random()
            if APP_SPECS[process].category == "Entertainment":
                phase += 0.62
            elif APP_SPECS[process].category == "Communication":
                phase += 0.12
            chunks.append((process, title, domain, seconds, phase))
            remaining -= seconds
    chunks.sort(key=lambda chunk: chunk[4])
    return [(process, title, domain, seconds) for process, title, domain, seconds, _ in chunks]


def _afk(rows: list, start: float, minutes: float, reason: str = "idle") -> float:
    end = start + minutes * 60
    rows.append((int(start), int(end), "afk", reason, None, 1))
    return end


def _day_sessions(
    rng: random.Random,
    day: datetime,
    targets: dict[str, float],
) -> list:
    if not targets:
        return []

    rows: list = []
    weekday = day.weekday() < 5
    base = day.timestamp()
    total_active = sum(targets.values()) * 3600
    start_hour = rng.uniform(8.15, 9.15) if weekday else rng.uniform(9.75, 11.25)
    current = base + start_hour * 3600
    active = 0
    lunch_done = False
    short_break_done = False
    evening_gap_done = False

    for process, title, domain, seconds in _activity_chunks(rng, targets):
        if weekday and not lunch_done and active >= 3.1 * 3600:
            current = _afk(rows, current, rng.uniform(35, 58), "idle")
            lunch_done = True
        if weekday and not short_break_done and active >= 6.1 * 3600:
            current = _afk(rows, current, rng.uniform(8, 16), "idle")
            short_break_done = True
        if (
            weekday
            and not evening_gap_done
            and total_active >= 8 * 3600
            and active >= total_active * 0.78
        ):
            current += rng.uniform(45, 85) * 60
            evening_gap_done = True
        if not weekday and not lunch_done and total_active >= 3 * 3600 and active >= 2 * 3600:
            current = _afk(rows, current, rng.uniform(25, 55), "idle")
            lunch_done = True

        end = current + seconds
        rows.append((int(current), int(end), process, title, domain, 0))
        current = end
        active += seconds
    return rows


def generate(out: Path, weeks: int, end_day: datetime, now_ts: int | None) -> int:
    rng = random.Random(SEED)
    days = weeks * 7
    rows: list = []
    current_week_start = end_day - timedelta(days=end_day.weekday())
    previous_week_start = current_week_start - timedelta(days=7)

    for i in range(days):
        day = end_day - timedelta(days=days - 1 - i)
        if current_week_start <= day < current_week_start + timedelta(days=7):
            targets = _recent_targets(day, CURRENT_WEEK_HOURS)
        elif previous_week_start <= day < current_week_start:
            targets = _recent_targets(day, PREVIOUS_WEEK_HOURS)
        else:
            targets = _historical_targets(rng, day, i // 7)
        rows.extend(_day_sessions(rng, day, targets))

    if now_ts is not None:
        # A default run may include today. Retain only activity that has really
        # reached the current wall clock; unlike the former developer fixture,
        # do not invent a late-night foreground session just to end on one.
        rows = [r for r in rows if r[0] < now_ts]
        rows = [(s, min(e, now_ts), p, t, d, a) for s, e, p, t, d, a in rows]

    conn = open_db(out)
    try:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_dataset','1')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('recording_consent','1')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('record_window_titles','1')")
        # Without these, App.tsx's privacy_onboarding_complete gate shows the
        # consent screen on every fresh demo.db — and both of its buttons write
        # to the real Windows registry regardless of which one is clicked.
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('privacy_onboarding_complete','1')"
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('starter_categories_pending','0')"
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('weekly_goal_hours','15')"
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('process_aliases',?)",
            (json.dumps(PROCESS_ALIASES, sort_keys=True),),
        )
        cat_ids = {r[1]: r[0] for r in conn.execute("SELECT id, name FROM categories")}
        conn.executemany(
            "INSERT INTO rules (match_type, pattern, category_id, priority) VALUES (?,?,?,?)",
            [
                (match_type, pattern, cat_ids[category], priority)
                for match_type, pattern, category, priority in DEMO_RULES
            ],
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
    ap.add_argument("--out", default=str(root / "data" / "demo.db"))
    ap.add_argument("--weeks", type=int, default=12)
    ap.add_argument("--end", help="last day (YYYY-MM-DD); default today, truncated at 'now'")
    ap.add_argument("--force", action="store_true", help="overwrite an unmarked existing file")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    # Both names: "database.db" is the live tracker database, and "time_log.db"
    # is what it was called before, so archived history keeps its guard too.
    if out.name in {"database.db", "time_log.db"}:
        print(f"refusing to write a real tracker database ({out.name})")
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
        # Cloud-sync filter drivers can hold the file open without blocking
        # writes; fall back to wiping user data in place. Keep schema_version:
        # open_db needs it to distinguish a current database from an abandoned
        # pre-release schema before it can reseed the starter rows.
        with sqlite3.connect(out) as conn:
            for table in (
                "session_corrections",
                "tracking_exclusions",
                "sessions",
                "rules",
                "categories",
            ):
                try:
                    conn.execute(f"DELETE FROM {table}")
                except sqlite3.OperationalError:
                    pass
            try:
                conn.execute("DELETE FROM settings WHERE key<>'schema_version'")
            except sqlite3.OperationalError:
                pass

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
