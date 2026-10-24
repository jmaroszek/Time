"""Operating-system code stays behind tracker.platforms.

Everything outside that package is meant to import on any OS, so that a port
adds a subpackage beside platforms/windows/ instead of editing the session
state machine, the database layer, or the tray. Read the source rather than
importing it: on Windows every import succeeds, which proves nothing about the
rule.
"""

import ast
from pathlib import Path

TRACKER = Path(__file__).resolve().parents[1]

# Modules that exist, or behave, only on one OS.
OS_MODULES = {
    "_winapi",
    "ctypes",
    "msvcrt",
    "pythoncom",
    "pywintypes",
    "win32api",
    "win32con",
    "win32event",
    "win32gui",
    "win32process",
    "win32security",
    "winreg",
    "winrt",
}
# Standard-library calls that exist only on Windows.
OS_ONLY_ATTRIBUTES = {("os", "startfile")}
# The tracker's logic. These may not reach into the platform layer at all; the
# composition root (tracker.py) and the tray hand them what they need.
CORE = {
    "break_reminder.py",
    "config.py",
    "db.py",
    "domains.py",
    "media_sites.py",
    "session_manager.py",
    "tracking_schedule.py",
}


def _imports(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module
            for alias in node.names:
                yield f"{node.module}.{alias.name}"


def _outside_platforms():
    modules = sorted(TRACKER.glob("*.py"))
    assert len(modules) > 5, "tracker modules are not where this test looks"
    for path in modules:
        yield path.name, ast.parse(path.read_text(encoding="utf-8"))


def test_no_os_api_outside_the_platform_layer():
    offenders = []
    for name, tree in _outside_platforms():
        for imported in _imports(tree):
            if imported.split(".")[0] in OS_MODULES:
                offenders.append(f"{name} imports {imported}")
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and (node.value.id, node.attr) in OS_ONLY_ATTRIBUTES
            ):
                offenders.append(f"{name} uses {node.value.id}.{node.attr}")
    assert not offenders, offenders


def test_core_modules_do_not_depend_on_the_platform_layer():
    offenders = [
        f"{name} imports {imported}"
        for name, tree in _outside_platforms()
        if name in CORE
        for imported in _imports(tree)
        if imported == "tracker.platforms" or imported.startswith("tracker.platforms.")
    ]
    assert not offenders, offenders
