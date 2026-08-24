"""Guards on the NSIS hooks, which nothing else can exercise.

An upgrade cannot be unit-tested: it needs two signed builds, a real install and
the Windows installer running against it. What is checkable is that the two
deletions in the uninstall hooks are still conditional, and still conditional on
the thing that actually distinguishes an upgrade -- because both failures are
silent. A lost Run value leaves the database still saying "start at sign-in is
on" over a registration that no longer exists, and a lost data directory leaves
nothing at all.

Read the hook file rather than compiling it, the way test_publish_release.py
reads the release script: makensis is a Windows-only build dependency, and the
properties worth protecting are in the source.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
HOOKS = (
    REPOSITORY / "dashboard" / "src-tauri" / "windows" / "installer-hooks.nsh"
).read_text(encoding="utf-8")
RUST = (REPOSITORY / "dashboard" / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")

# The variable the hooks use to mean "an installer is driving this uninstall".
UPGRADE_STEP = "$UninstallIsUpgradeStep"


def macro_body(name):
    body = re.search(rf"^!macro {name}$(.*?)^!macroend$", HOOKS, re.M | re.S)
    assert body, f"{name} is not defined in installer-hooks.nsh"
    return "\n".join(
        line for line in body.group(1).splitlines() if not line.strip().startswith(";")
    )


def conditions_around(body, statement):
    """The ${If}/${AndIf} conditions a statement sits under, outermost first."""
    stack = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("${If}"):
            stack.append([line])
        elif line.startswith(("${AndIf}", "${OrIf}")):
            assert stack, f"{line} outside any ${{If}}"
            stack[-1].append(line)
        elif line.startswith("${Else}"):
            assert stack, "${Else} outside any ${If}"
            stack[-1] = ["${Else}"]
        elif line.startswith("${EndIf}"):
            assert stack, "${EndIf} outside any ${If}"
            stack.pop()
        elif line.startswith(statement):
            return [condition for block in stack for condition in block]
    raise AssertionError(f"no {statement!r} statement in the macro")


def test_the_run_value_survives_an_installer_driven_uninstall():
    """The whole defect. An in-place upgrade runs the previous version's
    uninstaller, and nothing in the new installation can put this value back."""
    conditions = conditions_around(macro_body("NSIS_HOOK_PREUNINSTALL"), "DeleteRegValue")
    assert any(UPGRADE_STEP in condition for condition in conditions), conditions


def test_the_users_history_survives_an_installer_driven_uninstall():
    """That uninstaller is not passive, so it shows its confirm page and offers
    the "delete application data" box mid-upgrade. Ticking it must not be able
    to take the history the upgrade exists to carry forward."""
    conditions = conditions_around(macro_body("NSIS_HOOK_POSTUNINSTALL"), "RmDir /r")
    assert any(UPGRADE_STEP in condition for condition in conditions), conditions


def test_update_mode_is_never_the_only_thing_standing_between_the_two():
    """$UpdateMode reads like the answer and is not one: the template sets it
    only from /UPDATE, and skips the uninstaller entirely when /UPDATE is
    present, so the uninstaller an upgrade runs always sees it unset. A guard
    that narrows back to it alone is the original bug returning."""
    for macro, statement in (
        ("NSIS_HOOK_PREUNINSTALL", "DeleteRegValue"),
        ("NSIS_HOOK_POSTUNINSTALL", "RmDir /r"),
    ):
        conditions = conditions_around(macro_body(macro), statement)
        assert not all("$UpdateMode" in condition for condition in conditions), conditions


def test_the_upgrade_test_is_the_uninstallers_own_location():
    """What makes the two distinguishable: NSIS re-execs the uninstaller from
    %TEMP% unless it was passed _?=, and the installer's reinstall path is the
    only caller that passes it. Assigned in PREUNINSTALL, which is inserted into
    the uninstall section ahead of POSTUNINSTALL, so both can read it."""
    body = macro_body("NSIS_HOOK_PREUNINSTALL")
    assert f"StrCpy {UPGRADE_STEP} 1" in body
    assert f"StrCpy {UPGRADE_STEP} 0" in body
    assert "$EXEDIR" in body and "$INSTDIR" in body
    assert f"Var {UPGRADE_STEP[1:]}" in HOOKS


def test_the_uninstaller_and_the_dashboard_name_the_same_registration():
    """Neither side can observe the other's spelling. If they drift, the
    uninstaller stops removing what the dashboard wrote, and Time leaves a
    startup entry behind on a machine it was removed from."""
    rust_key = re.search(r'STARTUP_RUN_KEY: &str = r"([^"]+)"', RUST)
    rust_value = re.search(r'STARTUP_RUN_VALUE: &str = "([^"]+)"', RUST)
    assert rust_key and rust_value
    hook_value = re.search(r'!define TIME_TRACKER_RUN_VALUE "([^"]+)"', HOOKS)
    assert hook_value
    assert hook_value.group(1) == rust_value.group(1)

    deletion = re.search(r'DeleteRegValue HKCU "([^"]+)"', HOOKS)
    assert deletion
    assert deletion.group(1) == rust_key.group(1)
    assert "${TIME_TRACKER_RUN_VALUE}" in macro_body("NSIS_HOOK_PREUNINSTALL")
