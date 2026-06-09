"""One-time migration: collapse legacy time_log samples into session rows.

Usage:  py scripts/migrate_samples.py [--db PATH]

Steps:
  1. Checkpoint the WAL and file-copy the DB to Data/backup_pre_migration.db.
  2. Bootstrap the new schema (idempotent) via tracker.db.
  3. Delete any previously migrated sessions (re-runnable).
  4. Merge consecutive samples with identical (process, title) and gap <=
     poll_rate + 5s into sessions; end_ts = last_sample_ts + poll_rate.
  5. Verify per-day totals (sessions clipped at local midnight) against the
     raw sample sums and print the comparison.

The time_log table itself is never modified.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker import db as tracker_db
from tracker.domains import parse_domain

GAP_TOLERANCE_EXTRA = 5.0


def collapse_samples(rows, gap_tolerance_extra: float = GAP_TOLERANCE_EXTRA):
    """rows: iterable of (ts, process_name, window_title, poll_rate), ts-ordered.

    Yields (start_ts, end_ts, process_lower, title) tuples.
    """
    cur = None
    for ts, proc, title, poll in rows:
        proc_l = (proc or "").lower()
        title = title or ""
        poll = float(poll)
        if (
            cur is not None
            and cur["proc"] == proc_l
            and cur["title"] == title
            and ts - cur["last_ts"] <= cur["poll"] + gap_tolerance_extra
        ):
            cur["last_ts"] = ts
            cur["poll"] = poll
        else:
            if cur is not None:
                yield (cur["start"], cur["last_ts"] + cur["poll"], cur["proc"], cur["title"])
            cur = {"start": ts, "last_ts": ts, "poll": poll, "proc": proc_l, "title": title}
    if cur is not None:
        yield (cur["start"], cur["last_ts"] + cur["poll"], cur["proc"], cur["title"])


def split_session_per_day(start_ts: float, end_ts: float) -> dict[str, float]:
    """Clip a session at local midnights -> {'YYYY-MM-DD': seconds}."""
    out: dict[str, float] = {}
    cursor = start_ts
    while cursor < end_ts:
        day_start = datetime.fromtimestamp(cursor).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        next_midnight = (day_start + timedelta(days=1)).timestamp()
        chunk_end = min(end_ts, next_midnight)
        out[day_start.strftime("%Y-%m-%d")] = out.get(day_start.strftime("%Y-%m-%d"), 0.0) + (
            chunk_end - cursor
        )
        cursor = chunk_end
    return out


def backup(db_path: Path) -> Path:
    backup_path = db_path.parent / "backup_pre_migration.db"
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    conn.close()
    shutil.copy2(db_path, backup_path)
    return backup_path


def migrate(db_path: Path) -> dict:
    conn = tracker_db.open_db(db_path)
    browsers = tracker_db.get_settings(conn).browser_processes

    n_samples = conn.execute("SELECT COUNT(*) FROM time_log").fetchone()[0]
    conn.execute("DELETE FROM sessions WHERE source = 'migrated'")

    rows = conn.execute(
        "SELECT timestamp, process_name, COALESCE(window_title,''), poll_rate"
        " FROM time_log ORDER BY timestamp ASC, id ASC"
    )
    batch = []
    n_sessions = 0
    conn.execute("BEGIN")
    for start, end, proc, title in collapse_samples(rows):
        domain = parse_domain(title) if proc in browsers else None
        batch.append((int(start), int(end), proc, title[:512], domain))
        n_sessions += 1
        if len(batch) >= 1000:
            conn.executemany(
                "INSERT INTO sessions (start_ts, end_ts, process, title, domain, is_afk, source)"
                " VALUES (?,?,?,?,?,0,'migrated')",
                batch,
            )
            batch.clear()
    if batch:
        conn.executemany(
            "INSERT INTO sessions (start_ts, end_ts, process, title, domain, is_afk, source)"
            " VALUES (?,?,?,?,?,0,'migrated')",
            batch,
        )
    conn.execute("COMMIT")

    # ---- verification: per-day totals ----
    sample_days: dict[str, float] = {
        row[0]: float(row[1])
        for row in conn.execute(
            "SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch', 'localtime') AS day,"
            " SUM(poll_rate) FROM time_log GROUP BY day"
        )
    }
    session_days: dict[str, float] = defaultdict(float)
    for start, end in conn.execute(
        "SELECT start_ts, end_ts FROM sessions WHERE source = 'migrated'"
    ):
        for day, secs in split_session_per_day(start, end).items():
            session_days[day] += secs

    deltas = {
        day: abs(sample_days.get(day, 0.0) - session_days.get(day, 0.0))
        for day in set(sample_days) | set(session_days)
    }
    max_delta = max(deltas.values()) if deltas else 0.0
    bad_days = {d: v for d, v in deltas.items() if v > 60.0}
    conn.close()
    return {
        "n_samples": n_samples,
        "n_sessions": n_sessions,
        "n_days": len(sample_days),
        "max_delta_seconds": max_delta,
        "bad_days": bad_days,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "Data" / "time_log.db",
    )
    args = parser.parse_args()

    if not args.db.exists():
        print(f"ERROR: DB not found: {args.db}")
        return 1

    backup_path = backup(args.db)
    print(f"Backup written to {backup_path}")

    stats = migrate(args.db)
    ratio = stats["n_samples"] / stats["n_sessions"] if stats["n_sessions"] else 0
    print(
        f"Migrated {stats['n_samples']:,} samples -> {stats['n_sessions']:,} sessions"
        f" ({ratio:.1f}x compression) across {stats['n_days']} days."
    )
    print(f"Max per-day delta vs samples: {stats['max_delta_seconds']:.0f}s")
    if stats["bad_days"]:
        print("Days with delta > 60s (investigate):")
        for day, delta in sorted(stats["bad_days"].items()):
            print(f"  {day}: {delta:.0f}s")
        return 1
    print("Per-day totals verified (all within 60s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
