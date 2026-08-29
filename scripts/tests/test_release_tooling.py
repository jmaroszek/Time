"""Static contracts for the scripts that make a release low-friction.

These exist because the friction they remove was itself a release risk: a
process painful enough to avoid is a process that ships fewer fixes. Each guard
below protects a property that, if it silently regressed, would return some of
that pain or quietly weaken a gate.

Read the scripts rather than running them, for the same reason
test_release_signing.py does: the real path spends cloud signatures and takes
fifteen minutes.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPTS = REPOSITORY / "scripts"

def strip_comments(source):
    """PowerShell block and line comments.

    These scripts explain at length why they avoid `-NoNewWindow` and
    `-AsSecureString`, so a guard that searched the raw text would fire on the
    documentation warning against the thing it forbids.
    """
    without_blocks = re.sub(r"<#.*?#>", "", source, flags=re.S)
    return "\n".join(
        line for line in without_blocks.splitlines() if not line.strip().startswith("#")
    )


def script(name):
    return (SCRIPTS / name).read_text(encoding="utf-8")


RELEASE = strip_comments(script("release.ps1"))
ENTER = strip_comments(script("enter_release_shell.ps1"))
SETUP = strip_comments(script("setup_release_secrets.ps1"))
BUILD_TRACKER = (SCRIPTS / "build_tracker.py").read_text(encoding="utf-8")
UNSIGNED = (SCRIPTS / "tests" / "test_unsigned_builds.py").read_text(encoding="utf-8")


def test_wrapper_proves_the_updater_key_before_spending_anything():
    """The key check is free and the mistake it catches is unrecoverable: a
    manifest signed by the wrong key is rejected by every installed copy of Time,
    and no later fix reaches them. It has to happen before the build, not after."""
    key_check = RELEASE.index("EXPECTED_KEY_ID = ")
    comparison = RELEASE.index("$keyId -ne $EXPECTED_KEY_ID")
    spawn = RELEASE.index("Start-Process pwsh")
    assert key_check < comparison < spawn


def test_wrapper_detaches_the_build_from_the_launching_console():
    """The whole point of the wrapper. Every process attached to a console
    receives that console's Ctrl+C, and a phantom one killed two release builds.
    A hidden-window child is not attached to ours; -NoNewWindow would be."""
    spawn_line = next(
        line for line in RELEASE.splitlines() if "Start-Process pwsh" in line
    )
    assert "-WindowStyle Hidden" in spawn_line
    assert "-NoNewWindow" not in RELEASE

    # The interactive profile is also kept out of the build: it is where the
    # duplicate starship/zoxide init and the conda hook live.
    spawn_block = RELEASE[RELEASE.index("$publishArgs = @(") : RELEASE.index("Start-Process pwsh")]
    assert '"-NoProfile"' in spawn_block


def test_wrapper_stays_on_the_signed_path():
    """Three scripts build this installer and only one may sign it. The wrapper
    delegates to publish_release.ps1 rather than building, so it must never
    acquire an override of its own -- that is the drift
    test_unsigned_builds.py exists to prevent."""
    assert "TIME_SIGN_COMMAND" not in RELEASE
    assert "signCommand" not in RELEASE

    # And it must not be mistaken for an unsigned builder, because it is not one.
    unsigned_list = UNSIGNED[UNSIGNED.index("UNSIGNED_BUILDERS = (") :]
    unsigned_list = unsigned_list[: unsigned_list.index(")")]
    assert "release.ps1" not in unsigned_list


def test_wrapper_stops_before_anything_irreversible():
    """Tagging and publishing are one-way. The wrapper prints them; it must not
    run them. A `git tag` or `gh release create` that is executed rather than
    printed would publish on the strength of a build the owner has not looked at."""
    for command in ("git tag", "gh release create", "git push"):
        for line in RELEASE.splitlines():
            if command in line and not line.strip().startswith("#"):
                assert "Write-Host" in line, f"{command!r} looks executed, not printed: {line.strip()}"


def test_tracker_build_is_quiet_by_default_and_can_be_turned_back_up():
    """PyInstaller's INFO level was the overwhelming majority of a release's
    output. Quiet is the default; the detail has to stay reachable, because the
    one time it matters is when bundling breaks."""
    assert '"TIME_PYINSTALLER_LOG_LEVEL", "WARN"' in BUILD_TRACKER
    argv = BUILD_TRACKER[BUILD_TRACKER.index('"PyInstaller",') : BUILD_TRACKER.index("cwd=ROOT")]
    assert '"--log-level"' in argv
    assert "log_level," in argv


def test_release_shell_reports_lengths_never_secret_values():
    """The confirmation step exists to catch a truncated or single-character
    paste. Printing the value itself would put a live signing secret into
    scrollback and any transcript."""
    secrets = ("AZURE_CLIENT_SECRET", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "TAURI_SIGNING_PRIVATE_KEY")
    for line in ENTER.splitlines():
        if "Write-Host" not in line:
            continue
        for secret in secrets:
            assert f"$env:{secret}" not in line, f"secret reaches stdout: {line.strip()}"
    assert ".Length" in ENTER


def test_setup_never_uses_the_unpastable_securestring_prompt():
    """-AsSecureString bypasses PSReadLine and reads the raw console, so a
    bracketed paste arrives as one character. It also buys nothing here: the
    value ends up in a plain environment variable either way."""
    for source, name in ((SETUP, "setup_release_secrets.ps1"), (ENTER, "enter_release_shell.ps1")):
        assert "-AsSecureString" not in source, f"{name} reintroduced it"


def test_stored_secrets_are_read_back_before_being_trusted():
    """A vault that accepts a write and returns something else is worse than no
    vault: the failure would surface as an authentication error deep inside a
    build, naming nothing resembling its cause."""
    assert "$readBack -ne $value" in SETUP
    assert re.search(r"\.Trim\(\)", SETUP), "password managers append a newline on copy"
