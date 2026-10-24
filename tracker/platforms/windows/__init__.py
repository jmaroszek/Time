"""The tracker's Windows platform layer, the one that ships."""

from tracker.platforms.windows.human_input import start_human_input_monitor
from tracker.platforms.windows.instance import (
    acquire_single_instance,
    install_console_shutdown_handler,
)
from tracker.platforms.windows.launch import dashboard_path, open_dashboard, open_url
from tracker.platforms.windows.media_playback import start_media_playback_monitor
from tracker.platforms.windows.notifications import start_notifier
from tracker.platforms.windows.power_events import start_power_event_monitor
from tracker.platforms.windows.probe import snapshot

__all__ = [
    "acquire_single_instance",
    "dashboard_path",
    "install_console_shutdown_handler",
    "open_dashboard",
    "open_url",
    "snapshot",
    "start_human_input_monitor",
    "start_media_playback_monitor",
    "start_notifier",
    "start_power_event_monitor",
]
