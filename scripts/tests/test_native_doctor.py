import importlib.util
from pathlib import Path

import pytest

from tracker import db


DOCTOR_PATH = (
    Path(__file__).resolve().parents[2]
    / "dashboard"
    / "device-test"
    / "native"
    / "doctor.py"
)
SPEC = importlib.util.spec_from_file_location("native_doctor", DOCTOR_PATH)
assert SPEC and SPEC.loader
native_doctor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(native_doctor)


def _native_fixture(path):
    connection = db.open_db(path)
    connection.executemany(
        "INSERT INTO settings (key,value) VALUES (?,?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [
            ("demo_dataset", "1"),
            ("privacy_onboarding_complete", "1"),
            ("launch_at_login", "0"),
        ],
    )
    connection.close()


def test_native_doctor_accepts_only_marked_scratch_database(tmp_path):
    local_app_data = tmp_path / "local"
    scratch = tmp_path / "device-compat.db"
    _native_fixture(scratch)

    report = native_doctor.validate_database(scratch, local_app_data)

    assert report["database"] == str(scratch.resolve())


def test_native_doctor_refuses_production_database_even_if_marked(tmp_path):
    local_app_data = tmp_path / "local"
    production = local_app_data / "Time" / "time_log.db"
    _native_fixture(production)

    with pytest.raises(ValueError, match="refusing production"):
        native_doctor.validate_database(production, local_app_data)


def test_native_doctor_refuses_unmarked_database(tmp_path):
    scratch = tmp_path / "device-compat.db"
    connection = db.open_db(scratch)
    connection.close()

    with pytest.raises(ValueError, match="not marked"):
        native_doctor.validate_database(scratch, tmp_path / "local")
