"""Validate that the native suite points only at its marked scratch database."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path


def validate_database(database: Path, local_app_data: Path) -> dict[str, str]:
    database = database.resolve()
    production = (local_app_data.resolve() / "Time" / "time_log.db").resolve()
    if database == production:
        raise ValueError("refusing production Time database")
    if not database.is_file():
        raise ValueError(f"scratch database does not exist: {database}")

    uri = f"{database.as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        connection.execute("PRAGMA query_only=ON")
        marker = connection.execute(
            "SELECT value FROM settings WHERE key='demo_dataset'"
        ).fetchone()
        if marker != ("1",):
            raise ValueError("database is not marked as a Time demo fixture")
        settings = dict(
            connection.execute(
                "SELECT key,value FROM settings"
                " WHERE key IN ('privacy_onboarding_complete','launch_at_login')"
            )
        )
        if settings.get("privacy_onboarding_complete") != "1":
            raise ValueError("native fixture must bypass onboarding")
        if settings.get("launch_at_login") != "0":
            raise ValueError("native fixture must not register Windows startup")
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity != ("ok",):
            raise ValueError(f"scratch database integrity failed: {integrity!r}")
    return {"database": str(database), "production": str(production)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    args = parser.parse_args()

    try:
        result = validate_database(
            args.database,
            Path(os.environ.get("LOCALAPPDATA", "")),
        )
    except (OSError, sqlite3.Error, ValueError) as error:
        raise SystemExit(error) from error
    print(json.dumps(result))


if __name__ == "__main__":
    main()
