import sqlite3
import sys

import pytest

from scripts import verify_packaged_smoke
from scripts.verify_packaged_smoke import verify_smoke_database
from tracker import db


def test_packaged_smoke_accepts_fresh_no_consent_database(tmp_path):
    local_app_data = tmp_path / "LOCALAPPDATA"
    path = local_app_data / "Time" / "Data" / "database.db"
    connection = db.open_db(path)
    connection.close()

    report = verify_smoke_database(path, local_app_data)

    assert report["recordingConsent"] is False
    assert report["sessionCount"] == 0
    assert report["integrity"] == "ok"


def test_packaged_smoke_refuses_database_outside_declared_scratch_root(tmp_path):
    outside = tmp_path / "elsewhere" / "database.db"
    connection = db.open_db(outside)
    connection.close()

    with pytest.raises(ValueError, match="outside scratch LOCALAPPDATA"):
        verify_smoke_database(outside, tmp_path / "LOCALAPPDATA")


def test_packaged_smoke_refuses_sessions_without_consent(tmp_path):
    local_app_data = tmp_path / "LOCALAPPDATA"
    path = local_app_data / "Time" / "Data" / "database.db"
    connection = db.open_db(path)
    connection.execute(
        "INSERT INTO sessions (start_ts,end_ts,process) VALUES (1,2,'code.exe')"
    )
    connection.close()

    with pytest.raises(ValueError, match="without consent"):
        verify_smoke_database(path, local_app_data)


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("schema_version", "999", "expected schema"),
        ("recording_consent", "1", "unexpectedly has consent"),
        ("launch_at_login", "1", "enabled Windows startup"),
    ],
)
def test_packaged_smoke_refuses_unsafe_settings(tmp_path, key, value, message):
    local_app_data = tmp_path / "LOCALAPPDATA"
    path = local_app_data / "Time" / "Data" / "database.db"
    connection = db.open_db(path)
    connection.execute("UPDATE settings SET value=? WHERE key=?", (value, key))
    connection.close()

    with pytest.raises(ValueError, match=message):
        verify_smoke_database(path, local_app_data)


def test_packaged_smoke_refuses_missing_database(tmp_path):
    local_app_data = tmp_path / "LOCALAPPDATA"

    with pytest.raises(ValueError, match="did not create"):
        verify_smoke_database(
            local_app_data / "Time" / "Data" / "database.db",
            local_app_data,
        )


def test_packaged_smoke_cli_emits_machine_readable_result(
    tmp_path, monkeypatch, capsys
):
    local_app_data = tmp_path / "LOCALAPPDATA"
    path = local_app_data / "Time" / "Data" / "database.db"
    connection = db.open_db(path)
    connection.close()
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_packaged_smoke.py",
            str(path),
            "--local-app-data",
            str(local_app_data),
        ],
    )

    verify_packaged_smoke.main()

    assert '"recordingConsent": false' in capsys.readouterr().out


def test_packaged_smoke_cli_labels_validation_failure(tmp_path, monkeypatch):
    local_app_data = tmp_path / "LOCALAPPDATA"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "verify_packaged_smoke.py",
            str(local_app_data / "Time" / "Data" / "database.db"),
            "--local-app-data",
            str(local_app_data),
        ],
    )

    with pytest.raises(SystemExit, match="PACKAGED_SMOKE_FAILED"):
        verify_packaged_smoke.main()
