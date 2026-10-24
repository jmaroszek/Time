"""Windows toast notifications, sent as Time rather than as the tracker.

A toast is attributed to an AppUserModelID, and Windows shows only those it can
resolve to something installed. The installer's Start-menu shortcut carries the
bundle identifier from tauri.conf.json as its ID, so toasts sent under it read
"Time" with Time's icon — whichever of Time's processes sends them, and without
the tray icon. A source run on a machine where Time was never installed has no
such shortcut, and Windows drops the toast; that is acceptable for a reminder.

No launch action: there is no COM activator registered for a click to reach, so
clicking only dismisses the toast.
"""

from __future__ import annotations

import logging
from typing import Any, Callable
from xml.sax.saxutils import escape

# Must equal "identifier" in dashboard/src-tauri/tauri.conf.json;
# tests/test_notifications.py reads both.
TIME_APP_ID = "com.trackwithtime.time"


def toast_xml(title: str, body: str) -> str:
    """Two lines of text, silent: Time's reminders should be seen, not heard."""
    return (
        "<toast>"
        '<visual><binding template="ToastGeneric">'
        f"<text>{escape(title)}</text>"
        f"<text>{escape(body)}</text>"
        "</binding></visual>"
        '<audio silent="true"/>'
        "</toast>"
    )


class Notifier:
    def __init__(self, notifier: Any, make_toast: Callable[[str], Any]):
        self._notifier = notifier
        self._make_toast = make_toast

    def show(self, title: str, body: str) -> bool:
        """Best effort: a toast that fails must never interrupt recording."""
        try:
            self._notifier.show(self._make_toast(toast_xml(title, body)))
        except Exception as exc:
            # Type only, as for media detection: projection diagnostics are not
            # trusted to keep content out of the log.
            logging.error("Notification failed | error=%s", type(exc).__name__)
            return False
        return True


def start_notifier() -> Notifier | None:
    """Return None when Windows or its projection declines."""
    try:
        from winrt.windows.data.xml.dom import XmlDocument
        from winrt.windows.ui.notifications import (
            ToastNotification,
            ToastNotificationManager,
        )

        def make_toast(xml: str) -> Any:
            document = XmlDocument()
            document.load_xml(xml)
            return ToastNotification(document)

        return Notifier(
            ToastNotificationManager.create_toast_notifier_with_id(TIME_APP_ID),
            make_toast,
        )
    except Exception as exc:
        logging.error(
            "Notifications unavailable; break reminders will not show | error=%s",
            type(exc).__name__,
        )
        return None
