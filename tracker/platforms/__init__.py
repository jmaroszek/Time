"""Everything the tracker needs from the operating system.

Modules outside this package do not import OS APIs (ctypes, pywin32, winrt) or
call OS-only functions such as ``os.startfile``; tests/test_platform_boundary.py
holds them to that. Each OS is a subpackage exporting the names that
``interface.py`` lists, and this module re-exports the running OS's set, so
callers write ``platforms.snapshot(...)`` and tests patch that same attribute.

Named ``platforms`` rather than ``platform``: tracker.py imports the standard
library's ``platform``, and running ``tracker/tracker.py`` puts this directory's
parent first on ``sys.path``, where a ``platform`` package would shadow it.
"""

from __future__ import annotations

import sys

from tracker.platforms.interface import PowerEvent

if sys.platform == "win32":
    from tracker.platforms.windows import (
        acquire_single_instance,
        dashboard_path,
        install_console_shutdown_handler,
        open_dashboard,
        open_url,
        snapshot,
        start_human_input_monitor,
        start_media_playback_monitor,
        start_power_event_monitor,
    )
else:
    raise ImportError(f"Time's tracker has no platform layer for {sys.platform!r} yet")

__all__ = [
    "PowerEvent",
    "acquire_single_instance",
    "dashboard_path",
    "install_console_shutdown_handler",
    "open_dashboard",
    "open_url",
    "snapshot",
    "start_human_input_monitor",
    "start_media_playback_monitor",
    "start_power_event_monitor",
]
