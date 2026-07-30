"""Verify the packaged tracker used only its declared scratch data directory."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from tracker.db import SCHEMA_VERSION


def verify_smoke_database(database: Path, local_app_data: Path) -> dict[str, object]:
    database = database.resolve()
    local_app_data = local_app_data.resolve()
    expected = (local_app_data / "Time" / "time_log.db").resolve()
    if database != expected:
        raise ValueError(f"database resolved outside scratch LOCALAPPDATA: {database}")
    if not database.is_file():
        raise ValueError(f"packaged tracker did not create {database}")

    uri = f"{database.as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        connection.execute("PRAGMA query_only=ON")
        settings = dict(connection.execute("SELECT key,value FROM settings"))
        schema_version = settings.get("schema_version")
        if schema_version != str(SCHEMA_VERSION):
            raise ValueError(
                f"expected schema {SCHEMA_VERSION}, found {schema_version!r}"
            )
        if settings.get("recording_consent") != "0":
            raise ValueError("fresh packaged smoke database unexpectedly has consent")
        if settings.get("launch_at_login") != "0":
            raise ValueError("packaged smoke database enabled Windows startup")
        session_count = connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        if session_count != 0:
            raise ValueError(
                f"fresh database recorded {session_count} session(s) without consent"
            )
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"integrity_check returned {integrity!r}")
        foreign_key_errors = len(list(connection.execute("PRAGMA foreign_key_check")))
        if foreign_key_errors:
            raise ValueError(
                f"foreign_key_check returned {foreign_key_errors} error(s)"
            )
    return {
        "database": str(database),
        "localAppData": str(local_app_data),
        "schemaVersion": int(schema_version),
        "recordingConsent": False,
        "sessionCount": session_count,
        "integrity": integrity,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--local-app-data", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = verify_smoke_database(args.database, args.local_app_data)
    except (OSError, sqlite3.Error, ValueError) as error:
        raise SystemExit(f"PACKAGED_SMOKE_FAILED: {error}") from error
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
