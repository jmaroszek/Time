"""One tracker per Windows user, and cleanup when its console goes away."""

from __future__ import annotations

import ctypes
import logging

from tracker import config

_ERROR_ACCESS_DENIED = 5
_ERROR_ALREADY_EXISTS = 183
_mutex_handle = None  # keep a module-level reference so the handle lives forever


def acquire_single_instance() -> bool:
    global _mutex_handle
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    # Global\ so a second logon session (RDP, fast user switching) of the same
    # user cannot run a second tracker against the same database.
    _mutex_handle = kernel32.CreateMutexW(None, False, config.MUTEX_NAME)
    if not _mutex_handle:
        error = ctypes.get_last_error()
        if error == _ERROR_ACCESS_DENIED:
            # The name is machine-wide, but its default DACL admits only the
            # account that created it. Denial means another Windows account's
            # tracker holds it, and that account records into its own
            # per-user database, so this one may record too. 1.2.0 allowed it.
            logging.info("Tracker mutex is held by another Windows account; continuing.")
            return True
        raise ctypes.WinError(error)
    return ctypes.get_last_error() != _ERROR_ALREADY_EXISTS


def install_console_shutdown_handler(handler) -> None:
    try:
        import win32api

        win32api.SetConsoleCtrlHandler(handler, True)
    except Exception:
        pass  # pythonw has no console; atexit still covers normal interpreter exit
