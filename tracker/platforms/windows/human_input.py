"""Human input timing that does not mistake automation for presence.

``GetLastInputInfo`` is a useful fail-safe but treats input inserted by
``SendInput`` like device input.  Utilities such as Caffeine deliberately use
that behavior to keep Windows awake, which previously also kept Time out of
AFK.  Low-level keyboard and mouse hooks label inserted events.  This monitor
uses those labels to ignore automation while retaining ``GetLastInputInfo`` as
the source of truth whenever a hook misses an event or becomes unavailable.

Only event timing and the Windows-provided injected flag are observed.  Key
codes, mouse positions, and typed content are never retained or exposed.
"""

from __future__ import annotations

from collections import deque
import ctypes
from ctypes import wintypes
import logging
import threading


WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14
HC_ACTION = 0
WM_QUIT = 0x0012
PM_NOREMOVE = 0x0000

LLKHF_INJECTED = 0x00000010
LLMHF_INJECTED = 0x00000001

_TICK_MASK = 0xFFFFFFFF
_INJECTED_MATCH_TOLERANCE_MS = 50
# The tracker treats a 60-second polling hole as unobserved. Keep provenance
# through any shorter stall so a busy machine cannot turn a Caffeine event back
# into apparent human input before the loop recovers.
_INJECTED_MATCH_WINDOW_MS = 60_000
_MAX_RECENT_INJECTED_EVENTS = 256
_START_TIMEOUT_SECONDS = 5.0
_STOP_TIMEOUT_SECONDS = 5.0

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


class _KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


_HOOK_PROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t,
    ctypes.c_int,
    wintypes.WPARAM,
    wintypes.LPARAM,
)

_user32.GetLastInputInfo.argtypes = [ctypes.POINTER(_LASTINPUTINFO)]
_user32.GetLastInputInfo.restype = wintypes.BOOL
_user32.SetWindowsHookExW.argtypes = [
    ctypes.c_int,
    _HOOK_PROC,
    wintypes.HANDLE,
    wintypes.DWORD,
]
_user32.SetWindowsHookExW.restype = wintypes.HANDLE
_user32.CallNextHookEx.argtypes = [
    wintypes.HANDLE,
    ctypes.c_int,
    wintypes.WPARAM,
    wintypes.LPARAM,
]
_user32.CallNextHookEx.restype = ctypes.c_ssize_t
_user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
_user32.UnhookWindowsHookEx.restype = wintypes.BOOL
_user32.GetMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
]
_user32.GetMessageW.restype = wintypes.BOOL
_user32.PeekMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
    wintypes.UINT,
]
_user32.PeekMessageW.restype = wintypes.BOOL
_user32.PostThreadMessageW.argtypes = [
    wintypes.DWORD,
    wintypes.UINT,
    wintypes.WPARAM,
    wintypes.LPARAM,
]
_user32.PostThreadMessageW.restype = wintypes.BOOL
_kernel32.GetTickCount64.restype = ctypes.c_ulonglong
_kernel32.GetCurrentThreadId.restype = wintypes.DWORD
_kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
_kernel32.GetModuleHandleW.restype = wintypes.HANDLE


def _read_last_input_tick() -> int:
    info = _LASTINPUTINFO(cbSize=ctypes.sizeof(_LASTINPUTINFO))
    if not _user32.GetLastInputInfo(ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(info.dwTime)


def _get_tick_count_ms() -> int:
    return int(_kernel32.GetTickCount64())


def _expand_tick(now_ms: int, tick32: int) -> int:
    """Place a 32-bit input tick in the current 64-bit tick-count epoch."""
    elapsed = ((now_ms & _TICK_MASK) - (tick32 & _TICK_MASK)) & _TICK_MASK
    return max(0, now_ms - elapsed)


def _tick_distance(left: int, right: int) -> int:
    forward = ((left & _TICK_MASK) - (right & _TICK_MASK)) & _TICK_MASK
    backward = ((right & _TICK_MASK) - (left & _TICK_MASK)) & _TICK_MASK
    return min(forward, backward)


class _HumanInputClock:
    """Combine hook provenance with the durable Windows last-input clock."""

    def __init__(self, now_ms: int, last_input_tick: int):
        self._lock = threading.Lock()
        self._last_human_ms = _expand_tick(now_ms, last_input_tick)
        self._last_seen_input_tick = last_input_tick & _TICK_MASK
        self._recent_injected: deque[tuple[int, int]] = deque(
            maxlen=_MAX_RECENT_INJECTED_EVENTS
        )

    def record_hook_event(self, event_tick: int, *, injected: bool, now_ms: int) -> None:
        with self._lock:
            if injected:
                self._recent_injected.append((event_tick & _TICK_MASK, now_ms))
            else:
                # The hook directly observes real input. Recording it here also
                # preserves a physical event followed by injected input before
                # the one-second tracker poll gets to sample LASTINPUTINFO.
                self._last_human_ms = max(self._last_human_ms, now_ms)

    def idle_seconds(self, now_ms: int, last_input_tick: int) -> float:
        tick32 = last_input_tick & _TICK_MASK
        with self._lock:
            if tick32 != self._last_seen_input_tick:
                self._last_seen_input_tick = tick32
                cutoff = now_ms - _INJECTED_MATCH_WINDOW_MS
                while self._recent_injected and self._recent_injected[0][1] < cutoff:
                    self._recent_injected.popleft()
                injected = any(
                    _tick_distance(tick32, event_tick)
                    <= _INJECTED_MATCH_TOLERANCE_MS
                    for event_tick, _observed_at in self._recent_injected
                )
                if not injected:
                    # If the hook missed an event, fail toward the established
                    # GetLastInputInfo behavior rather than falsely marking a
                    # present user AFK.
                    self._last_human_ms = max(
                        self._last_human_ms,
                        _expand_tick(now_ms, tick32),
                    )
            return max(0.0, (now_ms - self._last_human_ms) / 1000.0)


class HumanInputMonitor:
    """Track the last non-injected keyboard or mouse event in this session."""

    def __init__(
        self,
        *,
        tick_clock=_get_tick_count_ms,
        last_input_reader=_read_last_input_tick,
    ):
        self._tick_clock = tick_clock
        self._last_input_reader = last_input_reader
        now_ms = self._tick_clock()
        self._clock = _HumanInputClock(now_ms, self._last_input_reader())
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._active = False
        self._start_error: BaseException | None = None
        self._keyboard_hook = wintypes.HANDLE()
        self._mouse_hook = wintypes.HANDLE()
        self._keyboard_callback = None
        self._mouse_callback = None

    def _record_keyboard(self, l_param: int) -> None:
        event = ctypes.cast(l_param, ctypes.POINTER(_KBDLLHOOKSTRUCT)).contents
        self._clock.record_hook_event(
            int(event.time),
            injected=bool(event.flags & LLKHF_INJECTED),
            now_ms=self._tick_clock(),
        )

    def _record_mouse(self, l_param: int) -> None:
        event = ctypes.cast(l_param, ctypes.POINTER(_MSLLHOOKSTRUCT)).contents
        self._clock.record_hook_event(
            int(event.time),
            injected=bool(event.flags & LLMHF_INJECTED),
            now_ms=self._tick_clock(),
        )

    def _run(self) -> None:
        self._thread_id = int(_kernel32.GetCurrentThreadId())

        def keyboard_callback(code, w_param, l_param):
            try:
                if code == HC_ACTION:
                    self._record_keyboard(l_param)
            except Exception:
                # Never let Python escape across a Win32 callback boundary.
                # LASTINPUTINFO remains the safe fallback for a missed event.
                pass
            return _user32.CallNextHookEx(None, code, w_param, l_param)

        def mouse_callback(code, w_param, l_param):
            try:
                if code == HC_ACTION:
                    self._record_mouse(l_param)
            except Exception:
                pass
            return _user32.CallNextHookEx(None, code, w_param, l_param)

        self._keyboard_callback = _HOOK_PROC(keyboard_callback)
        self._mouse_callback = _HOOK_PROC(mouse_callback)

        try:
            module = _kernel32.GetModuleHandleW(None)
            self._keyboard_hook = wintypes.HANDLE(
                _user32.SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    self._keyboard_callback,
                    module,
                    0,
                )
            )
            if not self._keyboard_hook.value:
                raise ctypes.WinError(ctypes.get_last_error())
            self._mouse_hook = wintypes.HANDLE(
                _user32.SetWindowsHookExW(
                    WH_MOUSE_LL,
                    self._mouse_callback,
                    module,
                    0,
                )
            )
            if not self._mouse_hook.value:
                raise ctypes.WinError(ctypes.get_last_error())

            # Force creation of this thread's message queue before start()
            # returns; close() can then always wake it with WM_QUIT.
            message = wintypes.MSG()
            _user32.PeekMessageW(
                ctypes.byref(message),
                None,
                WM_QUIT,
                WM_QUIT,
                PM_NOREMOVE,
            )
            self._active = True
            self._ready.set()

            while True:
                result = _user32.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result == 0:
                    break
                if result == -1:
                    raise ctypes.WinError(ctypes.get_last_error())
                _user32.TranslateMessage(ctypes.byref(message))
                _user32.DispatchMessageW(ctypes.byref(message))
        except BaseException as exc:
            if not self._ready.is_set():
                self._start_error = exc
            else:
                logging.error(
                    "Human input monitoring stopped; Windows idle fallback applies"
                    " | error=%s",
                    type(exc).__name__,
                )
        finally:
            self._active = False
            if self._mouse_hook.value:
                _user32.UnhookWindowsHookEx(self._mouse_hook)
            if self._keyboard_hook.value:
                _user32.UnhookWindowsHookEx(self._keyboard_hook)
            self._mouse_hook = wintypes.HANDLE()
            self._keyboard_hook = wintypes.HANDLE()
            self._thread_id = 0
            self._ready.set()

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._ready.clear()
        self._start_error = None
        self._thread = threading.Thread(
            target=self._run,
            name="time-human-input",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(_START_TIMEOUT_SECONDS):
            raise TimeoutError("human input hook startup timed out")
        if self._start_error is not None:
            raise self._start_error
        if not self._active:
            raise RuntimeError("human input hook stopped during startup")

    def idle_seconds(self) -> float:
        if not self._active:
            now_ms = self._tick_clock()
            return max(
                0.0,
                (now_ms - _expand_tick(now_ms, self._last_input_reader())) / 1000.0,
            )
        return self._clock.idle_seconds(
            self._tick_clock(),
            self._last_input_reader(),
        )

    def close(self) -> None:
        thread = self._thread
        if thread is None or not thread.is_alive():
            return
        thread_id = self._thread_id
        if thread_id and not _user32.PostThreadMessageW(thread_id, WM_QUIT, 0, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        thread.join(timeout=_STOP_TIMEOUT_SECONDS)
        if thread.is_alive():
            raise TimeoutError("human input hook did not stop")


def start_human_input_monitor() -> HumanInputMonitor | None:
    monitor: HumanInputMonitor | None = None
    try:
        monitor = HumanInputMonitor()
        monitor.start()
    except Exception as exc:
        if monitor is not None:
            try:
                monitor.close()
            except Exception:
                pass
        logging.error(
            "Human input monitoring unavailable; injected input may postpone AFK"
            " | error=%s",
            type(exc).__name__,
        )
        return None
    return monitor
