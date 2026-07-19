"""Build the PyInstaller one-dir tracker expected by Tauri externalBin."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import platform
import shutil
import subprocess
import sys
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
