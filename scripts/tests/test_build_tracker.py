import importlib.metadata
import subprocess
from pathlib import Path

import pytest

from scripts import build_tracker


def test_verify_pinned_runtime_accepts_exact_versions(tmp_path, monkeypatch):
    requirements = tmp_path / "requirements.txt"
    requirements.write_text(
        "# runtime\nexample-one==1.2.3\nexample-two==4.5.6\n",
        encoding="utf-8",
    )
    installed = {"example-one": "1.2.3", "example-two": "4.5.6"}
    monkeypatch.setattr(build_tracker, "REQUIREMENTS_PATH", requirements)
    monkeypatch.setattr(
        build_tracker.importlib.metadata,
        "version",
        installed.__getitem__,
    )

    build_tracker._verify_pinned_runtime()


def test_verify_pinned_runtime_reports_missing_and_mismatched_packages(
    tmp_path, monkeypatch
):
    requirements = tmp_path / "requirements.txt"
    requirements.write_text(
        "installed-package==2.0\nmissing-package==1.0\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(build_tracker, "REQUIREMENTS_PATH", requirements)

    def installed_version(name):
        if name == "installed-package":
            return "1.0"
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(
        build_tracker.importlib.metadata,
        "version",
        installed_version,
    )

    with pytest.raises(SystemExit) as error:
        build_tracker._verify_pinned_runtime()

    message = str(error.value)
    assert "installed-package: expected 2.0, found 1.0" in message
    assert "missing-package: expected 1.0, found not installed" in message


@pytest.mark.parametrize(
    ("architecture", "expected"),
    [
        ("AMD64", "x86_64-pc-windows-msvc"),
        ("x64", "x86_64-pc-windows-msvc"),
        ("ARM64", "aarch64-pc-windows-msvc"),
        ("x86", "i686-pc-windows-msvc"),
    ],
)
def test_target_triple_maps_windows_architectures(
    architecture, expected, monkeypatch
):
    monkeypatch.setenv("TAURI_ENV_ARCH", architecture)

    assert build_tracker._target_triple(None) == expected


def test_target_triple_prefers_explicit_value():
    assert build_tracker._target_triple("custom-triple") == "custom-triple"


def test_target_triple_refuses_unknown_architecture(monkeypatch):
    monkeypatch.setenv("TAURI_ENV_ARCH", "mips")

    with pytest.raises(SystemExit, match="Unsupported Windows build architecture"):
        build_tracker._target_triple(None)


def test_sidecar_manifest_requires_per_monitor_v2(monkeypatch, tmp_path):
    manifest = b"""<assembly>
      <dpiAware>true/pm</dpiAware>
      <dpiAwareness>PerMonitorV2</dpiAwareness>
    </assembly>"""
    monkeypatch.setattr(build_tracker, "_read_embedded_manifest", lambda _path: manifest)

    build_tracker._verify_sidecar_manifest(tmp_path / "time-tracker.exe")


@pytest.mark.parametrize(
    "manifest",
    [
        b"<assembly><dpiAware>true/pm</dpiAware></assembly>",
        b"<assembly><dpiAwareness>PerMonitorV2</dpiAwareness></assembly>",
        b"<assembly><dpiAware>true</dpiAware><dpiAwareness>system</dpiAwareness></assembly>",
    ],
)
def test_sidecar_manifest_rejects_missing_dpi_contract(
    manifest, monkeypatch, tmp_path
):
    monkeypatch.setattr(build_tracker, "_read_embedded_manifest", lambda _path: manifest)

    with pytest.raises(SystemExit, match="manifest does not declare"):
        build_tracker._verify_sidecar_manifest(tmp_path / "time-tracker.exe")


def _fake_run(monkeypatch, *, returncode, write_database):
    """Stand in for launching the packaged sidecar, and record its isolation."""
    captured = {}

    def run(command, *, cwd, env, capture_output, text, timeout):
        captured["env"] = env
        if write_database:
            database = Path(env["LOCALAPPDATA"]) / "Time" / "Data" / "database.db"
            database.parent.mkdir(parents=True, exist_ok=True)
            database.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(command, returncode, "", "boom")

    monkeypatch.setattr(build_tracker.subprocess, "run", run)
    return captured


def test_sidecar_check_runs_against_an_isolated_scratch_profile(monkeypatch, tmp_path):
    captured = _fake_run(monkeypatch, returncode=0, write_database=True)
    monkeypatch.setenv("TIME_DATA_DIR", str(tmp_path / "should-be-ignored"))

    build_tracker._verify_sidecar_starts(tmp_path / "time-tracker.exe")

    environment = captured["env"]
    assert environment["TIME_MIGRATE_ONLY"] == "1"
    # A developer's live tracker owns the production mutex; sharing it would
    # turn this into a duplicate-instance exit that proves nothing.
    assert environment["TIME_MUTEX_NAME"] != "Global\\TimeTrackerSingleton"
    assert "TIME_DATA_DIR" not in environment
    assert environment["LOCALAPPDATA"] != str(tmp_path)


def test_sidecar_check_fails_the_build_when_the_bundle_cannot_start(
    monkeypatch, tmp_path
):
    _fake_run(monkeypatch, returncode=1, write_database=False)

    with pytest.raises(SystemExit, match="Packaged tracker did not start"):
        build_tracker._verify_sidecar_starts(tmp_path / "time-tracker.exe")


def test_sidecar_check_fails_when_no_database_is_produced(monkeypatch, tmp_path):
    """A zero exit with no database means the run bailed out early rather than
    bootstrapping — the duplicate-instance path returns exactly that."""
    _fake_run(monkeypatch, returncode=0, write_database=False)

    with pytest.raises(SystemExit, match="Packaged tracker did not start"):
        build_tracker._verify_sidecar_starts(tmp_path / "time-tracker.exe")
