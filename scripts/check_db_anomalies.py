"""Read-only SQLite health and invariant checks for beta Time databases.

Usage:
    python scripts/check_db_anomalies.py path\to\time_log.db
    python scripts/check_db_anomalies.py path\to\time_log.db --json

The checker opens SQLite with ``mode=ro`` and ``query_only=ON``. It never runs
migrations, checkpoints the WAL, or modifies the database.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker.db import SCHEMA_VERSION  # noqa: E402

REQUIRED_TABLES = {"sessions", "categories", "rules", "settings"}


def _result(name: str, ok: bool, count: int = 0, detail: str = "") -> dict[str, Any]:
    return {"name": name, "ok": ok, "count": count, "detail": detail}


def _count(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> int:
    return int(conn.execute(sql, params).fetchone()[0])


def _read_heartbeat(conn: sqlite3.Connection) -> float:
    row = conn.execute(
        "SELECT value FROM settings WHERE key='heartbeat_seconds'"
    ).fetchone()
    try:
        return float(row[0]) if row is not None else 15.0
    except (TypeError, ValueError):
        return 15.0


def check_database(db_path: str | Path, *, now: float | None = None) -> list[dict[str, Any]]:
    """Return named checks. Every check with ``ok=False`` is release-actionable."""
    path = Path(db_path).resolve()
    uri = f"{path.as_uri()}?mode=ro"
    checks: list[dict[str, Any]] = []
    with sqlite3.connect(uri, uri=True, timeout=5) as conn:
        conn.execute("PRAGMA query_only=ON")

        integrity_rows = [str(row[0]) for row in conn.execute("PRAGMA integrity_check")]
        integrity_ok = integrity_rows == ["ok"]
        checks.append(
            _result(
                "integrity_check",
                integrity_ok,
                0 if integrity_ok else len(integrity_rows),
                "ok" if integrity_ok else "; ".join(integrity_rows[:5]),
            )
        )

        present = {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        missing = sorted(REQUIRED_TABLES - present)
        checks.append(
            _result(
                "required_tables",
                not missing,
                len(missing),
                "all present" if not missing else "missing: " + ", ".join(missing),
            )
        )
        if missing:
            return checks

        version_row = conn.execute(
            "SELECT value FROM settings WHERE key='schema_version'"
        ).fetchone()
        try:
            version = int(version_row[0]) if version_row is not None else None
        except (TypeError, ValueError):
            version = None
        version_ok = version is not None and 0 <= version <= SCHEMA_VERSION
        checks.append(
            _result(
                "schema_version",
                version_ok,
                0 if version_ok else 1,
                f"{version} (checker supports through {SCHEMA_VERSION})"
                if version is not None
                else "missing or non-integer",
            )
        )

        now_ts = time.time() if now is None else now
        stale_cutoff = now_ts - max(300.0, 2 * _read_heartbeat(conn))
        count_checks = [
            (
                "negative_duration_sessions",
                "SELECT COUNT(*) FROM sessions WHERE end_ts < start_ts",
                (),
            ),
            (
                "stale_zero_duration_sessions",
                "SELECT COUNT(*) FROM sessions WHERE end_ts = start_ts AND end_ts < ?",
                (stale_cutoff,),
            ),
            (
                "overlapping_sessions",
                "WITH ordered AS ("
                " SELECT id,start_ts,end_ts,MAX(end_ts) OVER ("
                "  ORDER BY start_ts,end_ts,id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING"
                " ) AS prior_end FROM sessions WHERE end_ts > start_ts"
                ") SELECT COUNT(*) FROM ordered WHERE start_ts < prior_end",
                (),
            ),
            (
                "afk_sessions_with_domains",
                "SELECT COUNT(*) FROM sessions WHERE is_afk != 0 AND domain IS NOT NULL",
                (),
            ),
            (
                "invalid_afk_flags",
                "SELECT COUNT(*) FROM sessions WHERE is_afk NOT IN (0,1)",
                (),
            ),
            (
                "empty_process_names",
                "SELECT COUNT(*) FROM sessions WHERE trim(process) = ''",
                (),
            ),
            (
                "duplicate_rules",
                "SELECT COUNT(*) FROM ("
                " SELECT 1 FROM rules GROUP BY match_type,pattern HAVING COUNT(*) > 1"
                ")",
                (),
            ),
            (
                "orphan_rules",
                "SELECT COUNT(*) FROM rules r LEFT JOIN categories c ON c.id=r.category_id"
                " WHERE c.id IS NULL",
                (),
            ),
            (
                "invalid_rule_types",
                "SELECT COUNT(*) FROM rules WHERE match_type NOT IN ('process','domain','title')",
                (),
            ),
            (
                "empty_rule_patterns",
                "SELECT COUNT(*) FROM rules WHERE trim(pattern) = ''",
                (),
            ),
        ]
        for name, sql, params in count_checks:
            count = _count(conn, sql, params)
            checks.append(_result(name, count == 0, count, "clean" if count == 0 else "found"))

        foreign_keys = list(conn.execute("PRAGMA foreign_key_check"))
        checks.append(
            _result(
                "foreign_key_check",
                not foreign_keys,
                len(foreign_keys),
                "clean" if not foreign_keys else "violations found",
            )
        )
    return checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="explicit path to the Time SQLite database")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--now", type=float, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    try:
        checks = check_database(args.database, now=args.now)
    except (OSError, sqlite3.Error) as exc:
        if args.json:
            print(json.dumps({"database": str(args.database.resolve()), "error": str(exc)}))
        else:
            print(f"ERROR: could not check {args.database.resolve()}: {exc}", file=sys.stderr)
        return 2

    failed = [check for check in checks if not check["ok"]]
    if args.json:
        print(
            json.dumps(
                {
                    "database": str(args.database.resolve()),
                    "ok": not failed,
                    "checks": checks,
                },
                indent=2,
            )
        )
    else:
        for check in checks:
            marker = "OK" if check["ok"] else "FAIL"
            print(f"{marker:4} {check['name']}: {check['detail']} (count={check['count']})")
        print(f"\n{'PASS' if not failed else 'FAIL'}: {len(failed)} failed check(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
