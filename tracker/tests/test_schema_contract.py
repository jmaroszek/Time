"""A fresh database is the same whichever runtime creates it.

The schema exists twice — `_SCHEMA` here and `BOOTSTRAP_SQL` in
dashboard/src-tauri/src/database/schema.rs — because either runtime may create
a user's database first. Each suite builds one and compares it with
contracts/schema.json, so a change to either copy fails in the suite of the
copy left behind. The Rust half is
`database::tests::bootstrap_matches_the_schema_contract`.
"""

import json
import re
from pathlib import Path

from tracker import db

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "schema.json").read_text(
        encoding="utf-8"
    )
)


def _normalized_sql(sql):
    """Comments removed and whitespace collapsed: the form the contract stores."""
    return " ".join(re.sub(r"--[^\n]*", "", sql or "").split())


def test_a_tracker_created_database_matches_the_schema_contract(tmp_path):
    conn = db.open_db(tmp_path / "fresh.db")
    try:
        objects = [
            {"type": kind, "name": name, "table": table, "sql": _normalized_sql(sql)}
            for kind, name, table, sql in conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master"
                " WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
            )
        ]
        cursor = conn.execute("SELECT * FROM categories ORDER BY id")
        columns = [column[0] for column in cursor.description]
        categories = [dict(zip(columns, row)) for row in cursor]
    finally:
        conn.close()
    assert objects == CONTRACT["objects"]
    assert categories == CONTRACT["categories"]
