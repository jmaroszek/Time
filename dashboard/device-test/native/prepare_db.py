"""Finalize the generated demo database for native compatibility tests only."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    args = parser.parse_args()

    with sqlite3.connect(args.database) as connection:
        marker = connection.execute(
            "SELECT value FROM settings WHERE key='demo_dataset'"
        ).fetchone()
        if marker is None:
            raise SystemExit(f"refusing to modify an unmarked database: {args.database}")
        connection.execute(
            "UPDATE settings SET value='1' WHERE key='privacy_onboarding_complete'"
        )
        connection.execute(
            "UPDATE settings SET value='0' WHERE key='launch_at_login'"
        )
        connection.commit()


if __name__ == "__main__":
    main()
