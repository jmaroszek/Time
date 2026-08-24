"""Guards on the launch path, which needs two builds and an upgrade to exercise.

Both properties here are ones a refactor removed once already, and both fail the
same way: Time does not open, and nothing anywhere says why. The window does not
exist yet, so the frontend cannot report it, and the release binary is built
windows-subsystem, so the panic has no console to print to. What the reader sees
is a shortcut that does nothing.

Read the source, the way test_installer_hooks.py does. Reproducing either needs a
database from a previous release and a real Windows install of this one.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
NATIVE = REPOSITORY / "dashboard" / "src-tauri" / "src"
RESTORE = (NATIVE / "restore.rs").read_text(encoding="utf-8")
LIB = (NATIVE / "lib.rs").read_text(encoding="utf-8")

# The helper that lets the tracker migrate before this release reads a database.
MIGRATING_OPEN = "open_current_database"


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


def test_an_ordinary_launch_can_migrate_a_database_from_a_previous_release():
    """The whole defect. An in-place upgrade migrates through the installer's
    POSTINSTALL hook, which starts the tracker with NSIS `Exec` and does not wait
    for it -- so the dashboard can and does reach the database first."""
    body = function_body(RESTORE, "open_database_with_pending_restore")
    ordinary_launch = re.search(r"Ok\(None\) => (.+?),\n", body, re.S)
    assert ordinary_launch, "the no-pending-restore arm is not where this looks"
    assert MIGRATING_OPEN in ordinary_launch.group(1), (
        "the ordinary launch opens the database without giving the tracker a"
        " chance to migrate it; a database one release behind ends the launch"
    )


def test_the_migrating_open_actually_runs_the_tracker():
    """The tracker is the sole migration owner, so the helper above is only
    worth routing through if it still calls it."""
    body = function_body(RESTORE, MIGRATING_OPEN)
    assert "system_run_tracker_migration" in body, (
        f"{MIGRATING_OPEN} no longer runs the tracker, so it repairs nothing"
    )
    assert "is_older_schema_error" in body, (
        f"{MIGRATING_OPEN} must migrate only for an older schema; every other"
        " open failure is one spawning a tracker cannot fix"
    )


def test_a_database_that_cannot_be_opened_is_reported_before_the_process_dies():
    """Anything this could not repair still ends the launch. Saying so is the
    difference between a bug report and a machine written off as broken."""
    setup = LIB[LIB.index(".setup(") :]
    opening = re.search(
        r"restore::open_database_with_pending_restore\(path\)(.{0,400})",
        setup,
        re.S,
    )
    assert opening, "setup() no longer opens the database where this looks"
    assert "report_fatal_launch_failure" in opening.group(1), (
        "a failed open leaves setup() without telling anyone; the release binary"
        " has no console and no window yet, so this is the only report there is"
    )
