"""PyInstaller one-dir build for the always-on tracker sidecar."""

import os
from pathlib import Path


tracker_dir = Path(SPECPATH).resolve()
project_root = tracker_dir.parent
icon_path = project_root / "dashboard" / "src-tauri" / "icons" / "icon.ico"
target_triple = os.environ.get(
    "TIME_TRACKER_TARGET_TRIPLE", "x86_64-pc-windows-msvc"
)

a = Analysis(
    [str(tracker_dir / "tracker.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=[(str(icon_path), "assets")],
    hiddenimports=["pystray._win32"],
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
