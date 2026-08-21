"""Isolated tests for the dependency-free release version parity check."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "check_version_parity.py"
SPEC = importlib.util.spec_from_file_location("check_version_parity", SCRIPT_PATH)
assert SPEC and SPEC.loader
parity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parity)


def _write_fixture(root: Path, versions: dict[str, str] | None = None) -> None:
    values = {"tauri": "0.1.0", "cargo": "0.1.0", "package": "0.1.0", "tracker": "0.1.0"}
    if versions:
        values.update(versions)
    (root / "dashboard" / "src-tauri").mkdir(parents=True)
    (root / "tracker").mkdir()
    (root / "dashboard" / "src-tauri" / "tauri.conf.json").write_text(
        '{"version": "' + values["tauri"] + '"}\n', encoding="utf-8"
    )
    (root / "dashboard" / "src-tauri" / "Cargo.toml").write_text(
        '[package]\nname = "time"\nversion = "' + values["cargo"] + '"\n',
        encoding="utf-8",
    )
    (root / "dashboard" / "package.json").write_text(
        '{"name": "dashboard", "version": "' + values["package"] + '"}\n',
        encoding="utf-8",
    )
    (root / "tracker" / "config.py").write_text(
        'TRACKER_VERSION = "' + values["tracker"] + '"\n', encoding="utf-8"
    )


def test_equal_declarations_pass(tmp_path, capsys):
    _write_fixture(tmp_path)

    assert parity.main(["--root", str(tmp_path)]) == 0
    assert "Version parity OK" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("component", "label"),
    [
        ("tauri", "tauri.conf.json"),
        ("cargo", "Cargo.toml"),
        ("package", "package.json"),
        ("tracker", "tracker/config.py"),
    ],
)
def test_each_drift_class_fails(tmp_path, capsys, component, label):
    _write_fixture(tmp_path, {component: "0.1.1"})

    assert parity.main(["--root", str(tmp_path)]) == 1
    error = capsys.readouterr().err
    assert "version declarations disagree" in error
    assert label in error


@pytest.mark.parametrize(
    "relative_path,contents,needle",
    [
        (
            Path("dashboard/src-tauri/tauri.conf.json"),
            "{\"version\": }\n",
            "tauri.conf.json",
        ),
        (
            Path("dashboard/src-tauri/Cargo.toml"),
            "[package\nversion = \"0.1.0\"\n",
            "Cargo.toml",
        ),
        (
            Path("dashboard/package.json"),
            "{\"version\": }\n",
            "package.json",
        ),
        (
            Path("tracker/config.py"),
            "TRACKER_VERSION = 0.1.0\n",
            "tracker/config.py",
        ),
    ],
)
def test_malformed_declaration_fails(tmp_path, capsys, relative_path, contents, needle):
    _write_fixture(tmp_path)
    (tmp_path / relative_path).write_text(contents, encoding="utf-8")

    assert parity.main(["--root", str(tmp_path)]) == 1
    assert needle in capsys.readouterr().err


@pytest.mark.parametrize(
    "relative_path,contents",
    [
        (Path("dashboard/src-tauri/tauri.conf.json"), "{}\n"),
        (Path("dashboard/src-tauri/Cargo.toml"), '[package]\nname = "time"\n'),
        (Path("dashboard/package.json"), '{"name": "dashboard"}\n'),
        (Path("tracker/config.py"), "import os\n"),
    ],
)
def test_missing_version_declaration_fails(tmp_path, capsys, relative_path, contents):
    _write_fixture(tmp_path)
    (tmp_path / relative_path).write_text(contents, encoding="utf-8")

    assert parity.main(["--root", str(tmp_path)]) == 1
    assert relative_path.name in capsys.readouterr().err


@pytest.mark.parametrize(
    "relative_path",
    [
        Path("dashboard/src-tauri/tauri.conf.json"),
        Path("dashboard/src-tauri/Cargo.toml"),
        Path("dashboard/package.json"),
        Path("tracker/config.py"),
    ],
)
def test_missing_declaration_fails(tmp_path, capsys, relative_path):
    _write_fixture(tmp_path)
    (tmp_path / relative_path).unlink()

    assert parity.main(["--root", str(tmp_path)]) == 1
    error = capsys.readouterr().err
    assert "missing" in error
    assert relative_path.name in error
