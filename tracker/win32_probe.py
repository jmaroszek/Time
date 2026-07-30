"""Win32 input layer: idle time, foreground process/title, UWP resolution.

Everything here returns plain data (a Snapshot); all interpretation lives in
session_manager. Keeping this boundary small also makes the Windows calls
replaceable in tests without weakening coverage of their edge-case handling.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

import psutil
import win32gui
import win32process

from tracker.session_manager import Snapshot

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

_UWP_HOST = "applicationframehost.exe"
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_ERROR_INSUFFICIENT_BUFFER = 122

_kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel32.CloseHandle.restype = wintypes.BOOL
_kernel32.GetApplicationUserModelId.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(wintypes.UINT),
    wintypes.LPWSTR,
]
_kernel32.GetApplicationUserModelId.restype = wintypes.LONG


class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def get_idle_seconds() -> float:
    """Idle seconds, robust to the 32-bit wraparound of LASTINPUTINFO.dwTime."""
    lii = _LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(_LASTINPUTINFO)
    if not _user32.GetLastInputInfo(ctypes.byref(lii)):
        raise ctypes.WinError(ctypes.get_last_error())
    now64 = int(_kernel32.GetTickCount64())
    last32 = int(lii.dwTime)
    now32 = now64 & 0xFFFFFFFF
    if now32 >= last32:
        diff_ms = now32 - last32
    else:
        diff_ms = (0x100000000 - last32) + now32
    return max(0.0, diff_ms / 1000.0)


_name_cache: dict[int, str] = {}
_app_id_cache: dict[int, str | None] = {}


def _proc_name(pid: int) -> str | None:
    if pid in _name_cache:
        return _name_cache[pid]
    try:
        name = psutil.Process(pid).name().lower()
    except Exception:
        return None
    if len(_name_cache) > 256:
        _name_cache.clear()
    _name_cache[pid] = name
    return name


def _proc_app_user_model_id(pid: int) -> str | None:
    """Return the packaged/explicit AUMID used by Windows media sessions."""
    if pid in _app_id_cache:
        return _app_id_cache[pid]
    handle = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        length = wintypes.UINT()
        result = _kernel32.GetApplicationUserModelId(handle, ctypes.byref(length), None)
        if result != _ERROR_INSUFFICIENT_BUFFER or length.value == 0:
            app_id = None
        else:
            buffer = ctypes.create_unicode_buffer(length.value)
            result = _kernel32.GetApplicationUserModelId(
                handle,
                ctypes.byref(length),
                buffer,
            )
            app_id = buffer.value if result == 0 and buffer.value else None
    finally:
        _kernel32.CloseHandle(handle)
    if len(_app_id_cache) > 256:
        _app_id_cache.clear()
    _app_id_cache[pid] = app_id
    return app_id


def _resolve_uwp_pid(hwnd: int, host_pid: int) -> int | None:
    """ApplicationFrameHost hosts the real UWP app in a child window."""
    found: list[int] = []

    def _cb(child: int, _arg: object) -> bool:
        _, pid = win32process.GetWindowThreadProcessId(child)
        if pid and pid != host_pid:
            found.append(pid)
            return False  # stop enumeration
        return True

    try:
        win32gui.EnumChildWindows(hwnd, _cb, None)
    except Exception:
        pass  # EnumChildWindows raises when the callback stops it early
    return found[0] if found else None


def snapshot(now: float) -> Snapshot:
    idle = get_idle_seconds()
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return Snapshot(now=now, idle_seconds=idle, process=None, title="")
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
    except Exception:
        return Snapshot(now=now, idle_seconds=idle, process=None, title="")
    if pid <= 0:
        return Snapshot(now=now, idle_seconds=idle, process=None, title="")

    name = _proc_name(pid)
    identity_pid = pid
    try:
        title = (win32gui.GetWindowText(hwnd) or "").replace("\x00", "")[:512]
    except Exception:
        title = ""

    if name == _UWP_HOST:
        child_pid = _resolve_uwp_pid(hwnd, pid)
        if child_pid:
            child_name = _proc_name(child_pid)
            if child_name:
                name = child_name
                identity_pid = child_pid

    return Snapshot(
        now=now,
        idle_seconds=idle,
        process=name,
        title=title,
        app_user_model_id=_proc_app_user_model_id(identity_pid),
    )
