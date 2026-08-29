"""Build the PyInstaller one-dir tracker expected by Tauri externalBin."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import platform
import shutil
import subprocess
import sys
import sysconfig
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
        database = Path(scratch) / "Time" / "Data" / "database.db"
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


_PE_SIGNATURE = b"PE\0\0"
# The optional header follows the four-byte signature and 20-byte COFF header.
_PE_OPTIONAL_HEADER_OFFSET_FROM_PE = 4 + 20
_PE_SUBSYSTEM_OFFSET = 68
_PE32_MAGIC = 0x10B
_PE32_PLUS_MAGIC = 0x20B
_WINDOWS_GUI_SUBSYSTEM = 2
# Offsets of the data-directory array within the optional header, which differ
# between PE32 and PE32+ because only the latter widens four base fields.
_PE_DATA_DIRECTORY_OFFSET = {_PE32_MAGIC: 96, _PE32_PLUS_MAGIC: 112}
# IMAGE_DIRECTORY_ENTRY_SECURITY. Unlike every other directory entry this one
# holds a file offset rather than an RVA, which is why an attached Authenticode
# signature can be detected without mapping the image.
_PE_SECURITY_DIRECTORY_INDEX = 4


def _read_pe_subsystem(executable: Path) -> int:
    """Read the PE optional-header subsystem without a third-party parser.

    The tracker is launched by Windows startup and by the NSIS post-install
    hook as well as by the GUI host. Those launchers cannot supply a
    ``CREATE_NO_WINDOW`` flag, so the executable itself must remain a GUI
    subsystem binary. Reading the small fixed PE header here keeps that
    packaging contract dependency-free.
    """
    try:
        with executable.open("rb") as stream:
            dos_header = stream.read(64)
            if len(dos_header) < 64 or dos_header[:2] != b"MZ":
                raise ValueError("missing DOS header")
            pe_offset = int.from_bytes(dos_header[0x3C:0x40], "little")
            stream.seek(pe_offset)
            if stream.read(4) != _PE_SIGNATURE:
                raise ValueError("missing PE signature")
            coff_header = stream.read(20)
            if len(coff_header) < 20:
                raise ValueError("truncated COFF header")
            optional_header_size = int.from_bytes(coff_header[16:18], "little")
            if optional_header_size < _PE_SUBSYSTEM_OFFSET + 2:
                raise ValueError("truncated optional header")
            optional_header = stream.read(optional_header_size)
            if len(optional_header) < optional_header_size:
                raise ValueError("truncated optional header")
            magic = int.from_bytes(optional_header[:2], "little")
            if magic not in {_PE32_MAGIC, _PE32_PLUS_MAGIC}:
                raise ValueError(f"unsupported optional-header magic 0x{magic:X}")
            return int.from_bytes(
                optional_header[_PE_SUBSYSTEM_OFFSET : _PE_SUBSYSTEM_OFFSET + 2],
                "little",
            )
    except OSError as error:
        raise ValueError(f"could not read executable: {error}") from error


def _verify_sidecar_subsystem(executable: Path) -> None:
    """Reject a tracker that could create a console when launched directly."""
    try:
        subsystem = _read_pe_subsystem(executable)
    except ValueError as error:
        raise SystemExit(f"Could not inspect packaged tracker PE: {error}") from error
    if subsystem != _WINDOWS_GUI_SUBSYSTEM:
        raise SystemExit(
            "Packaged tracker is not a Windows GUI executable "
            f"(PE subsystem={subsystem}); PyInstaller must use console=False"
        )


def _has_attached_signature(executable: Path) -> bool:
    """Report whether the PE carries a certificate table.

    This says a signature blob is attached, not that it is valid or trusted —
    ``verify_release.ps1`` is what decides that, because only Windows can chain
    a certificate and check a timestamp. The distinction matters: the failure
    this guards against is a sign command that exits 0 without doing anything,
    which no amount of trust checking later can attribute back to this build.
    """
    try:
        with executable.open("rb") as stream:
            dos_header = stream.read(64)
            if len(dos_header) < 64 or dos_header[:2] != b"MZ":
                raise ValueError("missing DOS header")
            pe_offset = int.from_bytes(dos_header[0x3C:0x40], "little")
            stream.seek(pe_offset)
            if stream.read(4) != _PE_SIGNATURE:
                raise ValueError("missing PE signature")
            coff_header = stream.read(20)
            if len(coff_header) < 20:
                raise ValueError("truncated COFF header")
            optional_header_size = int.from_bytes(coff_header[16:18], "little")
            optional_header = stream.read(optional_header_size)
            if len(optional_header) < optional_header_size:
                raise ValueError("truncated optional header")
            magic = int.from_bytes(optional_header[:2], "little")
            try:
                directory_offset = _PE_DATA_DIRECTORY_OFFSET[magic]
            except KeyError:
                raise ValueError(
                    f"unsupported optional-header magic 0x{magic:X}"
                ) from None
            entry = directory_offset + _PE_SECURITY_DIRECTORY_INDEX * 8
            if len(optional_header) < entry + 8:
                # No certificate table in an optional header that stops short of
                # the entry describing one.
                return False
            size = int.from_bytes(optional_header[entry + 4 : entry + 8], "little")
            return size > 0
    except OSError as error:
        raise ValueError(f"could not read executable: {error}") from error


def _sign_sidecar(executable: Path) -> None:
    """Authenticode-sign the sidecar, if the release shell asked for it.

    Tauri runs this script through ``beforeBundleCommand`` and then copies the
    sidecar into the bundle, so this is the last moment at which the tracker can
    be signed and still reach users signed. Signing it any later means signing a
    staging copy nobody ships.

    Off unless ``TIME_SIGN_COMMAND`` is set, because every development and
    update-rehearsal build runs this same path and none of them should spend a
    signature. ``%1`` is substituted with the executable path, matching the
    convention Tauri's own ``signCommand`` uses so one string can serve both.
    """
    template = os.environ.get("TIME_SIGN_COMMAND")
    if not template:
        return
    if "%1" not in template:
        raise SystemExit(
            "TIME_SIGN_COMMAND must contain %1, the placeholder for the file to "
            "sign; without it the command would sign nothing and still succeed."
        )
    command = template.replace("%1", f'"{executable}"')
    # Not echoed: a sign command is where a password or token would appear if
    # one were ever passed as an argument rather than through the environment.
    print("Signing tracker sidecar ...")
    completed = subprocess.run(command, shell=True, capture_output=True, text=True)
    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()
        raise SystemExit(f"Signing the tracker sidecar failed:\n{details}")
    try:
        signed = _has_attached_signature(executable)
    except ValueError as error:
        raise SystemExit(
            f"Could not confirm the tracker sidecar was signed: {error}"
        ) from error
    if not signed:
        raise SystemExit(
            "TIME_SIGN_COMMAND reported success but left no signature on "
            f"{executable}. The release would ship an unsigned tracker."
        )


def _target_triple(explicit: str | None) -> str:
    if explicit:
        return explicit
    # Tauri supplies this variable during bundling, but isolated Windows build
    # environments may expose neither it nor platform.machine(). Python's own
    # build-platform tag is the final local source of the interpreter's target.
    arch = (os.environ.get("TAURI_ENV_ARCH") or "").strip().lower()
    if not arch:
        arch = platform.machine().strip().lower()
    if not arch:
        arch = (os.environ.get("PROCESSOR_ARCHITEW6432") or "").strip().lower()
    if not arch:
        arch = (os.environ.get("PROCESSOR_ARCHITECTURE") or "").strip().lower()
    if not arch:
        arch = sysconfig.get_platform().strip().lower()
    triples = {
        "amd64": "x86_64-pc-windows-msvc",
        "x86_64": "x86_64-pc-windows-msvc",
        "x64": "x86_64-pc-windows-msvc",
        "win-amd64": "x86_64-pc-windows-msvc",
        "arm64": "aarch64-pc-windows-msvc",
        "aarch64": "aarch64-pc-windows-msvc",
        "win-arm64": "aarch64-pc-windows-msvc",
        "x86": "i686-pc-windows-msvc",
        "i686": "i686-pc-windows-msvc",
        "win32": "i686-pc-windows-msvc",
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
    # PyInstaller's INFO level narrates every hook, module and dependency it
    # considers -- upwards of a thousand lines for this bundle, none of which
    # anyone reads when the build works. It was the overwhelming majority of the
    # noise a release produced. WARN keeps the lines that mean something.
    #
    # Nothing is lost by this: release.ps1 captures the full output to a log file
    # regardless, which is more than the old behaviour, where the only copy was
    # terminal scrollback. Set TIME_PYINSTALLER_LOG_LEVEL=INFO (or DEBUG, TRACE)
    # when a bundling problem needs the detail back.
    log_level = os.environ.get("TIME_PYINSTALLER_LOG_LEVEL", "WARN")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--log-level",
            log_level,
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
    _verify_sidecar_subsystem(built_exe)
    _verify_sidecar_starts(built_exe)

    if TAURI_BINARIES.exists():
        shutil.rmtree(TAURI_BINARIES)
    shutil.copytree(built_dir, TAURI_BINARIES)

    # Sign the copy under binaries/, not the one under dist/: Tauri bundles from
    # here, so this is the file whose bytes reach the installer.
    sidecar = TAURI_BINARIES / built_exe.name
    _sign_sidecar(sidecar)
    return sidecar


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-triple")
    args = parser.parse_args()
    output = build(_target_triple(args.target_triple))
    print(f"Built tracker sidecar: {output}")


if __name__ == "__main__":
    main()
