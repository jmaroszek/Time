"""Merge a donor Time database's recorded history into a base database.

Usage:
    python scripts/merge_databases.py --base OLD.db --donor TRIAL.db --output MERGED.db
    python scripts/merge_databases.py --base OLD.db --donor TRIAL.db --output MERGED.db --json

The base database is the authority for user-managed data: its categories,
rules, and settings survive unchanged. The donor contributes recorded history —
sessions, their corrections, and tracking exclusions — which is what a
throwaway trial profile is actually worth keeping.

Neither input is modified. Both are copied to a scratch directory first, along
with any ``-wal`` and ``-shm`` sidecars, so a donor whose tracker was stopped
mid-checkpoint still contributes everything it recorded. Merging the ``.db``
file alone silently drops whatever is only in the write-ahead log.

Session ids collide by construction: both databases number from 1. Donor
sessions are re-inserted above the base's highest id and every reference to
them is remapped in lockstep. Categories are reconciled by name, never by id,
because two databases assign different ids to the same category.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tracker.db import SCHEMA_VERSION  # noqa: E402

SESSION_COLUMNS = "start_ts,end_ts,process,title,domain,is_afk,source"
RULE_COLUMNS = (
    "match_type,pattern,category_id,priority,"
    "scope_kind,scope_value,title_match_mode,title_anchor"
)
CATEGORY_COLUMNS = "name,color,is_productive,is_neutral,is_ignored,sort_order"


class MergeError(RuntimeError):
    """A merge that cannot be completed safely."""


def _staged_copy(source: Path, directory: Path, name: str) -> Path:
    """Copy a database and its sidecars so the original is never opened."""
    target = directory / name
    shutil.copy2(source, target)
    for suffix in ("-wal", "-shm"):
        sidecar = source.with_name(source.name + suffix)
        if sidecar.is_file():
            shutil.copy2(sidecar, target.with_name(target.name + suffix))
    return target


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
    try:
        return int(row[0]) if row is not None else 0
    except (TypeError, ValueError):
        return 0


def _require_sound(conn: sqlite3.Connection, label: str) -> int:
    rows = [str(row[0]) for row in conn.execute("PRAGMA integrity_check")]
    if rows != ["ok"]:
        raise MergeError(f"{label} failed integrity_check: {'; '.join(rows[:5])}")
    version = _schema_version(conn)
    if version != SCHEMA_VERSION:
        raise MergeError(
            f"{label} is at schema {version}, but this tool merges schema"
            f" {SCHEMA_VERSION}. Run the packaged tracker against it with"
            " TIME_MIGRATE_ONLY=1 before merging."
        )
    return version


def _category_map(
    merged: sqlite3.Connection,
    donor: sqlite3.Connection,
    wanted: set[int],
    policy: str,
) -> tuple[dict[int, int], list[str], list[str]]:
    """Map donor category ids onto merged ids, importing by name where needed."""
    by_name = {row["name"]: row["id"] for row in merged.execute("SELECT id,name FROM categories")}
    mapping: dict[int, int] = {}
    matched: list[str] = []
    imported: list[str] = []
    next_order = merged.execute(
        "SELECT COALESCE(MAX(sort_order),0)+1 FROM categories"
    ).fetchone()[0]

    for row in donor.execute(f"SELECT id,{CATEGORY_COLUMNS} FROM categories ORDER BY id"):
        existing = by_name.get(row["name"])
        if existing is not None:
            mapping[row["id"]] = existing
            matched.append(row["name"])
            continue
        if policy == "none" or (policy == "referenced" and row["id"] not in wanted):
            continue
        cursor = merged.execute(
            "INSERT INTO categories"
            f" ({CATEGORY_COLUMNS}) VALUES (?,?,?,?,?,?)",
            (
                row["name"],
                row["color"],
                row["is_productive"],
                row["is_neutral"],
                row["is_ignored"],
                next_order,
            ),
        )
        next_order += 1
        mapping[row["id"]] = int(cursor.lastrowid)
        imported.append(row["name"])
    return mapping, matched, imported


def merge_databases(
    base_path: str | Path,
    donor_path: str | Path,
    output_path: str | Path,
    *,
    donor_rules: str = "discard",
    donor_categories: str = "referenced",
    force: bool = False,
) -> dict[str, Any]:
    """Write a merged database and return a report of what moved."""
    base = Path(base_path).resolve()
    donor = Path(donor_path).resolve()
    output = Path(output_path).resolve()

    for label, path in (("base", base), ("donor", donor)):
        if not path.is_file():
            raise MergeError(f"{label} database not found: {path}")
    if base == donor:
        raise MergeError("base and donor are the same file")
    if output in {base, donor}:
        raise MergeError("output would overwrite an input database")
    if output.exists() and not force:
        raise MergeError(f"output already exists: {output} (pass --force to replace)")

    report: dict[str, Any] = {"base": str(base), "donor": str(donor), "output": str(output)}

    with tempfile.TemporaryDirectory(prefix="time-merge-") as scratch:
        directory = Path(scratch)
        staged_base = _staged_copy(base, directory, "base.db")
        staged_donor = _staged_copy(donor, directory, "donor.db")

        # closing(), not the connection's own context manager: that one commits
        # without closing, and the open handle blocks the scratch directory's
        # cleanup on Windows.
        with closing(_connect(staged_base)) as source, closing(_connect(staged_donor)) as donor_conn:
            _require_sound(source, "base database")
            _require_sound(donor_conn, "donor database")

            # VACUUM INTO folds the staged write-ahead log into one clean file,
            # which is the same mechanism the app's own backup command uses.
            output.parent.mkdir(parents=True, exist_ok=True)
            if output.exists():
                output.unlink()
            escaped = str(output).replace("'", "''")
            source.execute(f"VACUUM INTO '{escaped}'")

            with closing(_connect(output)) as merged:
                report.update(_apply(merged, donor_conn, donor_rules, donor_categories))
                problems = list(merged.execute("PRAGMA foreign_key_check"))
                if problems:
                    raise MergeError(
                        f"merged database has {len(problems)} dangling reference(s)"
                    )
                integrity = [str(row[0]) for row in merged.execute("PRAGMA integrity_check")]
                if integrity != ["ok"]:
                    raise MergeError(f"merged database failed integrity_check: {integrity[:5]}")
                merged.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return report


def _apply(
    merged: sqlite3.Connection,
    donor: sqlite3.Connection,
    donor_rules: str,
    donor_categories: str,
) -> dict[str, Any]:
    offset = int(merged.execute("SELECT COALESCE(MAX(id),0) FROM sessions").fetchone()[0])
    base_sessions = int(merged.execute("SELECT COUNT(*) FROM sessions").fetchone()[0])

    wanted = {
        int(row[0])
        for row in donor.execute(
            "SELECT DISTINCT category_id FROM session_corrections WHERE category_id IS NOT NULL"
        )
    }
    if donor_rules == "keep":
        wanted |= {int(row[0]) for row in donor.execute("SELECT DISTINCT category_id FROM rules")}

    mapping, matched, imported = _category_map(merged, donor, wanted, donor_categories)

    merged.executemany(
        f"INSERT INTO sessions (id,{SESSION_COLUMNS})"
        " VALUES (?,?,?,?,?,?,?,?)",
        [
            (
                row["id"] + offset,
                row["start_ts"],
                row["end_ts"],
                row["process"],
                row["title"],
                row["domain"],
                row["is_afk"],
                row["source"],
            )
            for row in donor.execute(f"SELECT id,{SESSION_COLUMNS} FROM sessions ORDER BY id")
        ],
    )
    moved_sessions = int(merged.execute("SELECT COUNT(*) FROM sessions").fetchone()[0])
    moved_sessions -= base_sessions

    corrections = 0
    dropped_corrections = 0
    for row in donor.execute("SELECT * FROM session_corrections"):
        category = row["category_id"]
        if category is not None and category not in mapping:
            dropped_corrections += 1
            continue
        merged.execute(
            "INSERT INTO session_corrections"
            " (session_id,corrected_start_ts,corrected_end_ts,category_id,updated_ts)"
            " VALUES (?,?,?,?,?)",
            (
                row["session_id"] + offset,
                row["corrected_start_ts"],
                row["corrected_end_ts"],
                None if category is None else mapping[category],
                row["updated_ts"],
            ),
        )
        corrections += 1

    rules_kept = 0
    rules_conflicted = 0
    if donor_rules == "keep":
        for row in donor.execute(f"SELECT {RULE_COLUMNS} FROM rules ORDER BY id"):
            if row["category_id"] not in mapping:
                rules_conflicted += 1
                continue
            cursor = merged.execute(
                f"INSERT OR IGNORE INTO rules ({RULE_COLUMNS})"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    row["match_type"],
                    row["pattern"],
                    mapping[row["category_id"]],
                    row["priority"],
                    row["scope_kind"],
                    row["scope_value"],
                    row["title_match_mode"],
                    row["title_anchor"],
                ),
            )
            if cursor.rowcount:
                rules_kept += 1
            else:
                rules_conflicted += 1
    donor_rule_total = int(donor.execute("SELECT COUNT(*) FROM rules").fetchone()[0])

    exclusions = 0
    for row in donor.execute("SELECT kind,pattern,created_ts FROM tracking_exclusions"):
        cursor = merged.execute(
            "INSERT OR IGNORE INTO tracking_exclusions (kind,pattern,created_ts) VALUES (?,?,?)",
            (row["kind"], row["pattern"], row["created_ts"]),
        )
        exclusions += cursor.rowcount

    base_settings = {row["key"] for row in merged.execute("SELECT key FROM settings")}
    added_settings = []
    for row in donor.execute("SELECT key,value FROM settings"):
        if row["key"] in base_settings:
            continue
        merged.execute("INSERT INTO settings (key,value) VALUES (?,?)", (row["key"], row["value"]))
        added_settings.append(row["key"])

    overlap = _overlap(merged, donor, offset)

    return {
        "sessions_imported": moved_sessions,
        "session_id_offset": offset,
        "categories_matched_by_name": sorted(set(matched)),
        "categories_imported": imported,
        "corrections_imported": corrections,
        "corrections_dropped": dropped_corrections,
        "donor_rules_total": donor_rule_total,
        "rules_imported": rules_kept,
        "rules_skipped": donor_rule_total - rules_kept if donor_rules == "keep" else donor_rule_total,
        "rules_conflicted": rules_conflicted,
        "exclusions_imported": exclusions,
        "settings_added": added_settings,
        "overlapping_seconds": overlap,
    }


def _overlap(merged: sqlite3.Connection, donor: sqlite3.Connection, offset: int) -> int:
    """Seconds of donor history that predate the base's last recorded session.

    Non-zero means the two databases recorded the same wall-clock time, which a
    sequential trial should never produce. It does not block the merge; it is
    the one signal that the donor is not the profile you think it is.
    """
    base_end = merged.execute(
        "SELECT COALESCE(MAX(end_ts),0) FROM sessions WHERE id <= ?", (offset,)
    ).fetchone()[0]
    donor_start = donor.execute("SELECT MIN(start_ts) FROM sessions").fetchone()[0]
    if donor_start is None or base_end is None:
        return 0
    return max(0, int(base_end) - int(donor_start))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="database whose rules and settings win")
    parser.add_argument("--donor", required=True, help="database whose sessions are imported")
    parser.add_argument("--output", required=True, help="merged database to write")
    parser.add_argument(
        "--donor-rules",
        choices=("discard", "keep"),
        default="discard",
        help="what to do with the donor's rules (default: discard)",
    )
    parser.add_argument(
        "--donor-categories",
        choices=("referenced", "all", "none"),
        default="referenced",
        help="which donor-only categories to import (default: those still referenced)",
    )
    parser.add_argument("--force", action="store_true", help="replace an existing output file")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = parser.parse_args(argv)

    try:
        report = merge_databases(
            args.base,
            args.donor,
            args.output,
            donor_rules=args.donor_rules,
            donor_categories=args.donor_categories,
            force=args.force,
        )
    except MergeError as error:
        print(f"merge failed: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(f"merged -> {report['output']}")
    print(f"  sessions imported     {report['sessions_imported']} (ids offset by {report['session_id_offset']})")
    print(f"  categories by name    {', '.join(report['categories_matched_by_name']) or 'none'}")
    print(f"  categories imported   {', '.join(report['categories_imported']) or 'none'}")
    print(f"  corrections imported  {report['corrections_imported']} (dropped {report['corrections_dropped']})")
    print(f"  rules imported        {report['rules_imported']} of {report['donor_rules_total']} (skipped {report['rules_skipped']})")
    print(f"  exclusions imported   {report['exclusions_imported']}")
    print(f"  settings added        {', '.join(report['settings_added']) or 'none'}")
    if report["overlapping_seconds"]:
        print(f"  WARNING: donor history overlaps base by {report['overlapping_seconds']}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
