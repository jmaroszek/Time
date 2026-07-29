"""Windows suspend/resume notifications for the tracker loop.

The power callback may run on a Windows-owned thread. It only timestamps and
queues boundaries; the tracker loop drains them and keeps all session/SQLite
writes on its existing single writer.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import logging
import threading
import time
from typing import Literal


DEVICE_NOTIFY_CALLBACK = 2
PBT_APMSUSPEND = 0x0004
PBT_APMRESUMECRITICAL = 0x0006
PBT_APMRESUMESUSPEND = 0x0007
PBT_APMRESUMEAUTOMATIC = 0x0012

_CALLBACK_ROUTINE = ctypes.WINFUNCTYPE(
    wintypes.ULONG,
    wintypes.LPVOID,
    wintypes.ULONG,
    wintypes.LPVOID,
)


class _DeviceNotifySubscribeParameters(ctypes.Structure):
    _fields_ = [
        ("Callback", _CALLBACK_ROUTINE),
        ("Context", wintypes.LPVOID),
    ]


@dataclass(frozen=True)
class PowerEvent:
    kind: Literal["suspend", "resume"]
    at: float
    # False means Windows delivered resume without this registration observing
    # the matching suspend. The session manager then ends the old row at its
    # last real observation instead of stretching it across the unknown gap.
    suspend_observed: bool = True


class PowerEventMonitor:
    """Normalize Windows notifications into one suspend/resume pair per cycle."""

    def __init__(self, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._events: deque[PowerEvent] = deque()
        self._lock = threading.Lock()
        self._suspend_observed = False
        self._automatic_resume_seen = False
        self._callback = None
        self._parameters = None
        self._powrprof = None
        self._handle = wintypes.HANDLE()

    def _record_notification(self, notification_type: int) -> None:
        event: PowerEvent | None = None
        with self._lock:
            if notification_type == PBT_APMSUSPEND:
                if not self._suspend_observed:
                    self._suspend_observed = True
                    self._automatic_resume_seen = False
                    event = PowerEvent("suspend", self._clock())
            elif notification_type in (
                PBT_APMRESUMEAUTOMATIC,
                PBT_APMRESUMECRITICAL,
            ):
                if not self._automatic_resume_seen:
                    event = PowerEvent(
                        "resume",
                        self._clock(),
                        suspend_observed=self._suspend_observed,
                    )
                    self._suspend_observed = False
                    self._automatic_resume_seen = True
            elif notification_type == PBT_APMRESUMESUSPEND:
                # Windows sends this user-present companion after the automatic
                # resume boundary. It is not a second wake and must not split
                # the fresh post-resume session.
                self._automatic_resume_seen = False
            if event is not None:
                self._events.append(event)

    def drain(self) -> list[PowerEvent]:
        with self._lock:
            events = list(self._events)
            self._events.clear()
        return events

    def start(self) -> None:
        if self._handle.value:
            return

        def _callback(_context, notification_type, _setting) -> int:
            try:
                self._record_notification(int(notification_type))
            except Exception:
                # Exceptions cannot cross a ctypes callback boundary. A missed
                # event is recovered by the next unpaired resume where possible.
                pass
            return 0

        self._callback = _CALLBACK_ROUTINE(_callback)
        self._parameters = _DeviceNotifySubscribeParameters(self._callback, None)
        self._powrprof = ctypes.WinDLL("PowrProf", use_last_error=True)

        register = self._powrprof.PowerRegisterSuspendResumeNotification
        register.argtypes = [
            wintypes.DWORD,
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.HANDLE),
        ]
        register.restype = wintypes.DWORD

        handle = wintypes.HANDLE()
        status = register(
            DEVICE_NOTIFY_CALLBACK,
            ctypes.cast(ctypes.byref(self._parameters), wintypes.HANDLE),
            ctypes.byref(handle),
        )
        if status != 0:
            raise OSError(status, ctypes.FormatError(status))
        self._handle = handle

    def close(self) -> None:
        if not self._handle.value or self._powrprof is None:
            return
        unregister = self._powrprof.PowerUnregisterSuspendResumeNotification
        unregister.argtypes = [wintypes.HANDLE]
        unregister.restype = wintypes.DWORD
        status = unregister(self._handle)
        self._handle = wintypes.HANDLE()
        if status != 0:
            logging.error(
                "Could not unregister suspend/resume notifications: %s",
                ctypes.FormatError(status),
            )


def start_power_event_monitor() -> PowerEventMonitor | None:
    monitor = PowerEventMonitor()
    try:
        monitor.start()
    except Exception as exc:
        logging.error(
            "Suspend/resume monitoring unavailable; sleep gaps may be"
            " attributed incorrectly: %s",
            exc,
        )
        return None
    return monitor
