"""Guards tying each build script to whether its output is Authenticode-signed.

Three scripts build the same installer and only one of them may sign it. Nothing
in the scripts observes tauri.conf.json's signCommand, and nothing in
tauri.conf.json knows the scripts exist, so the two drifted the moment signing
was introduced: rehearse_update.ps1 went on printing "Unsigned (no Authenticode)"
while building a signed artifact and spending a certificate operation to do it.

Both directions cost something real, which is why both are asserted here. An
unsigned path that starts signing burns a signature on a throwaway build. The
release path losing its signature ships an installer every user's machine will
warn about.

Read the scripts rather than running them: each takes fifteen minutes and the
release one needs five credentials.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPTS = REPOSITORY / "scripts"


def script(name):
    return (SCRIPTS / name).read_text(encoding="utf-8")


def strip_comments(source):
    """PowerShell line comments, so a mention in prose is not taken for code."""
    return "\n".join(
        line for line in source.splitlines() if not line.strip().startswith("#")
    )


# Every script that builds an installer without meaning to sign it. A new one
# belongs in this list; that is the point of the list.
UNSIGNED_BUILDERS = ("build_test_installer.ps1", "rehearse_update.ps1")

# What the override has to say. Tauri merges the document over tauri.conf.json,
# so null is what removes the inherited command.
OVERRIDE = re.compile(r"signCommand\s*=\s*\$null")


def test_the_config_still_carries_a_sign_command():
    """The overrides below are only meaningful while there is something to
    override. If this ever fails, the release path stopped signing and the whole
    question changed shape."""
    config = (
        REPOSITORY / "dashboard" / "src-tauri" / "tauri.conf.json"
    ).read_text(encoding="utf-8")
    assert '"signCommand"' in config, (
        "tauri.conf.json no longer defines a signCommand; the release would ship"
        " unsigned and these guards would pass while meaning nothing"
    )


def test_every_unsigned_build_path_overrides_the_sign_command():
    """The defect. A script whose banner promises no Authenticode has to make
    that true in the config it builds with, not merely refrain from asking."""
    for name in UNSIGNED_BUILDERS:
        assert OVERRIDE.search(strip_comments(script(name))), (
            f"{name} builds without overriding signCommand, so it inherits the"
            " release signing command and Authenticode-signs an artifact it"
            " tells the reader is unsigned"
        )


def test_the_release_path_does_not_override_the_sign_command():
    """The other direction, and the more expensive one to get wrong: a release
    that silently stopped signing is only discovered by users."""
    assert not OVERRIDE.search(strip_comments(script("publish_release.ps1"))), (
        "publish_release.ps1 disables signing; its output is the only build that"
        " may reach a user, and it must be signed"
    )


def test_the_test_installer_asks_for_no_keys_at_all():
    """Its reason to exist beside the rehearsal script. Needing a key would make
    it one more thing to set up before a VM pass, which is how a test build stops
    being taken."""
    source = strip_comments(script("build_test_installer.ps1"))
    assert re.search(r"createUpdaterArtifacts\s*=\s*\$false", source), (
        "build_test_installer.ps1 leaves updater artifacts on, so it needs"
        " TAURI_SIGNING_PRIVATE_KEY and is no longer the zero-setup path"
    )
    assert "TAURI_SIGNING_PRIVATE_KEY" not in source, (
        "build_test_installer.ps1 references the updater key; it is meant to"
        " build with no keys of any kind"
    )


def test_the_test_installer_verifies_its_own_artifact_is_unsigned():
    """Source guards catch a script that stopped asking. Only the artifact catches
    a bundler that stopped listening -- and by then the signature is spent, so the
    build has to say so rather than pass quietly."""
    source = strip_comments(script("build_test_installer.ps1"))
    assert "Get-AuthenticodeSignature" in source and "NotSigned" in source, (
        "build_test_installer.ps1 no longer checks the installer it produced;"
        " an override that stops working would go unnoticed"
    )
