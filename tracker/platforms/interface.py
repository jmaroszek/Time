"""What the tracker asks of an operating system, whichever one it is.

Each OS subpackage exports these names, and ``tracker.platforms`` re-exports
the running OS's set:

- ``snapshot(now, *, idle_seconds=None) -> Snapshot``: the foreground app, its
  window title, and input idle time, as plain data that ``session_manager``
  interprets.
- ``start_human_input_monitor()``: an object with ``idle_seconds()`` and
  ``close()`` that counts only human input, or None.
- ``start_media_playback_monitor()``: an object with
  ``is_foreground_playing(...)``, or None.
- ``start_power_event_monitor()``: an object with ``drain() -> list[PowerEvent]``
  and ``close()``, or None.
- ``acquire_single_instance() -> bool``: False when this user's tracker is
  already running.
- ``install_console_shutdown_handler(handler)``: call ``handler`` when a
  console close, logoff, or shutdown ends the process; best effort.
- ``dashboard_path() -> Path | None``, ``open_dashboard(path)``, and
  ``open_url(url)``: what the tray needs to open the dashboard and a mail
  draft.

A monitor factory returns None when the OS declines, and the tracker then runs
without that capability rather than failing to start.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class PowerEvent:
    kind: Literal["suspend", "resume"]
    at: float
    # False means Windows delivered resume without this registration observing
    # the matching suspend. The session manager then ends the old row at its
    # last real observation instead of stretching it across the unknown gap.
    suspend_observed: bool = True
