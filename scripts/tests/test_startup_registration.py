"""Guards on who may write the Windows startup registration.

Every Time build shares the one "Time Tracker" Run value. A debug build that
writes it repoints sign-in at `target\\debug`: the next login records the day
with a dev tracker, and nothing says so. That happened on 22 October 2026, after
a debug build ran against the real database the evening before.

Read the source, the way test_launch_recovery.py does. Exercising it for real
means writing the Run value Windows actually reads.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
WINDOWS = (
    REPOSITORY / "dashboard" / "src-tauri" / "src" / "platform" / "windows.rs"
).read_text(encoding="utf-8")


def function_body(source, name):
    """The body of one `fn name(...)`, by brace depth."""
    start = re.search(rf"^(?:pub(?:\([a-z]+\))? )?fn {name}\(", source, re.M)
    assert start, f"{name} is not defined where this test looks for it"
    opened = source.index("{", start.start())
    depth = 0
    for index in range(opened, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[opened : index + 1]
    raise AssertionError(f"{name} has no closing brace")


def test_a_debug_build_is_not_allowed_to_register_startup():
    flag = re.search(r"^const REGISTERS_STARTUP: bool = (.+);$", WINDOWS, re.M)
    assert flag, "REGISTERS_STARTUP is not defined where this test looks for it"
    assert flag.group(1).strip() == "!cfg!(debug_assertions)", (
        "a debug build may write the shared Run value again, so a dev run"
        " against the real database repoints sign-in at target\\debug"
    )


def test_the_only_write_of_the_run_value_is_behind_the_flag():
    # The scratch-key tests write it too, but only to their own key.
    production = WINDOWS.split("#[cfg(test)]", 1)[0]
    assert len(re.findall(r"\.set_value\(\s*STARTUP_RUN_VALUE", production)) == 1, (
        "the Run value is written somewhere this guard does not cover"
    )

    body = function_body(production, "set_launch_at_login")
    guarded = re.search(
        r"if enabled && REGISTERS_STARTUP \{(.+?)\} else \{", body, re.S
    )
    assert guarded, (
        "set_launch_at_login writes the Run value without asking whether"
        " this build may"
    )
    assert "STARTUP_RUN_VALUE" in guarded.group(1), (
        "the guarded branch no longer holds the write it is meant to guard"
    )
