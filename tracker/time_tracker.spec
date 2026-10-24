"""PyInstaller one-dir build for the always-on tracker sidecar."""

import json
import os
from pathlib import Path

from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)


tracker_dir = Path(SPECPATH).resolve()
project_root = tracker_dir.parent
icon_path = project_root / "dashboard" / "src-tauri" / "icons" / "icon.ico"
manifest_path = tracker_dir / "time_tracker.manifest"
app_config = json.loads(
    (project_root / "dashboard" / "src-tauri" / "tauri.conf.json").read_text(
        encoding="utf-8"
    )
)
app_version = app_config["version"]
version_numbers = tuple(
    int(part) for part in app_version.split("-", 1)[0].split("+", 1)[0].split(".")
) + (0,)
# Windows uses FileDescription as a friendly label; keep the executable's
# identity separate so startup commands and process detection remain stable.
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=version_numbers, prodvers=version_numbers, fileType=1),
    kids=[
        StringFileInfo([
            StringTable("040904B0", [
                StringStruct("CompanyName", app_config["bundle"]["publisher"]),
                StringStruct("FileDescription", "Time"),
                StringStruct("FileVersion", app_version),
                StringStruct("InternalName", "time-tracker"),
                StringStruct("OriginalFilename", "time-tracker.exe"),
                StringStruct("ProductName", "Time"),
                StringStruct("ProductVersion", app_version),
                StringStruct("Comments", "Background activity tracker for Time."),
            ]),
        ]),
        VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
    ],
)
target_triple = os.environ.get(
    "TIME_TRACKER_TARGET_TRIPLE", "x86_64-pc-windows-msvc"
)


a = Analysis(
    [str(tracker_dir / "tracker.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=[(str(icon_path), "assets")],
    hiddenimports=[
        "pystray._win32",
        "winrt.runtime",
        "winrt.windows.data.xml.dom",
        "winrt.windows.foundation",
        "winrt.windows.foundation.collections",
        "winrt.windows.media",
        "winrt.windows.media.control",
        "winrt.windows.storage.streams",
        "winrt.windows.ui.notifications",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Keep optional scientific/Linux/macOS backends from leaking out of a broad
    # developer environment into this Windows-only tray build.
    excludes=[
        "gi",
        "numpy",
        "Xlib",
        "pystray._appindicator",
        "pystray._darwin",
        "pystray._gtk",
        "pystray._xorg",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=f"time-tracker-{target_triple}",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(icon_path),
    manifest=str(manifest_path),
    version=version_info,
    contents_directory="_internal",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="time-tracker",
)
