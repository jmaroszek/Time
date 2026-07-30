import importlib.metadata

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
