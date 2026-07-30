"""Build the PyInstaller one-dir tracker expected by Tauri externalBin."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TRACKER_DIR = ROOT / "tracker"
SPEC_PATH = TRACKER_DIR / "time_tracker.spec"
DIST_DIR = TRACKER_DIR / "dist"
WORK_DIR = TRACKER_DIR / "build"
TAURI_BINARIES = ROOT / "dashboard" / "src-tauri" / "binaries"
REQUIREMENTS_PATH = TRACKER_DIR / "requirements.txt"


def _verify_pinned_runtime() -> None:
    """Never package whatever happens to be installed in the build Python."""
    mismatches: list[str] = []
    for raw in REQUIREMENTS_PATH.read_text(encoding="utf-8").splitlines():
        requirement = raw.strip()
        if not requirement or requirement.startswith("#"):
            continue
        name, expected = requirement.split("==", 1)
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            actual = "not installed"
        if actual != expected:
            mismatches.append(f"{name}: expected {expected}, found {actual}")
    if mismatches:
        details = "\n  ".join(mismatches)
        raise SystemExit(
            "Tracker build environment does not match tracker/requirements.txt:\n"
            f"  {details}\nInstall the pinned requirements before building."
        )


def _verify_sidecar_starts(executable: Path) -> None:
    """A bundle can build cleanly and still be missing a DLL its first import
    needs, which surfaces only when someone runs the release. Start the thing
    once, against a scratch profile, and let the build fail instead.

    Isolated three ways: LOCALAPPDATA moves the database into the temporary
    directory, TIME_MIGRATE_ONLY stops before the tray and the recording loop,
    and a distinct mutex keeps a developer's live tracker from turning this into
    a duplicate-instance exit that proves nothing.
    """
    with tempfile.TemporaryDirectory(prefix="time-sidecar-check-") as scratch:
        environment = os.environ.copy()
        environment["LOCALAPPDATA"] = scratch
        environment["TIME_MIGRATE_ONLY"] = "1"
        environment["TIME_MUTEX_NAME"] = "Global\\TimeTrackerBuildCheck"
        environment.pop("TIME_DATA_DIR", None)
        completed = subprocess.run(
            [str(executable)],
            cwd=executable.parent,
            env=environment,
            capture_output=True,
            text=True,
            timeout=120,
        )
        database = Path(scratch) / "Time" / "time_log.db"
        if completed.returncode != 0 or not database.is_file():
            details = (completed.stderr or completed.stdout or "").strip()
            raise SystemExit(
                "Packaged tracker did not start "
                f"(exit {completed.returncode}):\n{details}\n"
                "The sidecar is not shippable. A conda-derived build Python is "
                "the usual cause; see the build notes in README.md."
            )


def _read_embedded_manifest(executable: Path) -> bytes:
    from PyInstaller.utils.win32.winmanifest import read_manifest_from_executable

    return read_manifest_from_executable(str(executable))


def _verify_sidecar_manifest(executable: Path) -> None:
    """Fail packaging before Windows can bitmap-scale the native tray menu."""
    try:
        root = ET.fromstring(_read_embedded_manifest(executable))
    except Exception as error:
        raise SystemExit(f"Could not inspect packaged tracker manifest: {error}") from error
    settings = {
        element.tag.rsplit("}", 1)[-1]: (element.text or "").strip()
        for element in root.iter()
    }
    if settings.get("dpiAwareness") != "PerMonitorV2":
        raise SystemExit(
            "Packaged tracker manifest does not declare PerMonitorV2 DPI awareness"
        )
    if settings.get("dpiAware", "").lower() != "true/pm":
        raise SystemExit(
            "Packaged tracker manifest does not declare the true/pm DPI fallback"
        )


def _target_triple(explicit: str | None) -> str:
    if explicit:
        return explicit
    arch = os.environ.get("TAURI_ENV_ARCH", platform.machine()).lower()
    triples = {
        "amd64": "x86_64-pc-windows-msvc",
        "x86_64": "x86_64-pc-windows-msvc",
        "x64": "x86_64-pc-windows-msvc",
        "arm64": "aarch64-pc-windows-msvc",
        "aarch64": "aarch64-pc-windows-msvc",
        "x86": "i686-pc-windows-msvc",
        "i686": "i686-pc-windows-msvc",
    }
    try:
        return triples[arch]
    except KeyError as exc:
        raise SystemExit(f"Unsupported Windows build architecture: {arch}") from exc


def build(target_triple: str) -> Path:
    _verify_pinned_runtime()
    env = os.environ.copy()
    env["TIME_TRACKER_TARGET_TRIPLE"] = target_triple
    # A conda interpreter keeps the DLLs its extension modules link against in
    # `Library\bin` rather than beside the modules. PyInstaller resolves binary
    # dependencies through PATH, so without this the bundle builds cleanly and
    # then dies on the first `import ctypes` — and again on `import sqlite3`.
    # Stock CPython has no such directory and is unaffected.
    library_bin = Path(sys.base_prefix) / "Library" / "bin"
    if library_bin.is_dir():
        env["PATH"] = f"{library_bin}{os.pathsep}{env.get('PATH', '')}"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(DIST_DIR),
            "--workpath",
            str(WORK_DIR),
            str(SPEC_PATH),
        ],
        cwd=ROOT,
        env=env,
        check=True,
    )

    built_dir = DIST_DIR / "time-tracker"
    built_exe = built_dir / f"time-tracker-{target_triple}.exe"
    if not built_exe.is_file() or not (built_dir / "_internal").is_dir():
        raise SystemExit("PyInstaller did not produce the expected one-dir layout")

    _verify_sidecar_manifest(built_exe)
    _verify_sidecar_starts(built_exe)

    if TAURI_BINARIES.exists():
        shutil.rmtree(TAURI_BINARIES)
    shutil.copytree(built_dir, TAURI_BINARIES)
    return TAURI_BINARIES / built_exe.name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-triple")
    args = parser.parse_args()
    output = build(_target_triple(args.target_triple))
    print(f"Built tracker sidecar: {output}")


if __name__ == "__main__":
    main()
