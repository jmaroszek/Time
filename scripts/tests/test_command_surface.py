"""The native command surface, seen from both sides of the IPC boundary.

`generate_handler!` in lib.rs is what the native host answers; the `invoke`
calls under dashboard/src are what the renderer asks for. Neither can observe
the other. A command the renderer calls but the host never registered fails
only when a reader reaches it, and a registered command nothing calls is
surface the webview can still reach with no code left that means to.

Read the source, the way test_installer_hooks.py does: the alternative is a
build of both halves.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
DASHBOARD = REPOSITORY / "dashboard"
LIB = (DASHBOARD / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")

# `invoke("name"` and `invoke<Type>("name"`, the only two shapes the renderer
# uses; the generic may itself contain angle brackets.
INVOKE = re.compile(r"""\binvoke(?:<.*?>)?\(\s*["']([a-z_]+)["']""")


def registered_commands():
    handler = re.search(r"generate_handler!\[(.*?)\]", LIB, re.S)
    assert handler, "generate_handler! is not where this test looks"
    names = [
        entry.strip().split("::")[-1]
        for entry in handler.group(1).split(",")
        if entry.strip()
    ]
    assert len(names) == len(set(names)), "a command is registered twice"
    return set(names)


def invoked_commands():
    names = set()
    for path in (DASHBOARD / "src").rglob("*"):
        if path.suffix not in {".ts", ".tsx"} or ".test." in path.name:
            continue
        names.update(INVOKE.findall(path.read_text(encoding="utf-8")))
    assert names, "no invoke calls found; the pattern has rotted"
    return names


def test_every_renderer_call_reaches_a_registered_command():
    missing = invoked_commands() - registered_commands()
    assert not missing, f"invoked but never registered: {sorted(missing)}"


def test_every_registered_command_has_a_caller():
    unused = registered_commands() - invoked_commands()
    assert not unused, f"registered but never invoked: {sorted(unused)}"
