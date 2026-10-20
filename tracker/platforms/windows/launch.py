"""What the tray launches: the installed dashboard, and the shell's handler for a URL."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def dashboard_path() -> Path | None:
    """Return the installed dashboard beside the packaged tracker, if present."""
    override = None if getattr(sys, "frozen", False) else os.environ.get("TIME_DASHBOARD_PATH")
    if override:
        candidate = Path(override)
    elif getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().with_name("Time.exe")
    else:
        # parents[3] is the repository root, seen from tracker/platforms/windows/.
        candidate = (
            Path(__file__).resolve().parents[3]
            / "dashboard"
            / "src-tauri"
            / "target"
            / "release"
            / "Time.exe"
        )
    return candidate if candidate.is_file() else None


def _dashboard_process_kwargs(path: Path) -> dict[str, object]:
    """Build portable launch options without flashing a Windows console."""
    kwargs: dict[str, object] = {"cwd": str(path.parent), "close_fds": True}
    create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", None)
    if create_no_window is not None:
        kwargs["creationflags"] = create_no_window
    return kwargs


def open_dashboard(path: Path) -> None:
    subprocess.Popen([str(path)], **_dashboard_process_kwargs(path))


def open_url(url: str) -> None:
    os.startfile(url)
