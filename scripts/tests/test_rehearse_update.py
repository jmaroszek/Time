"""Guards on the rehearsal script's separation from the release path.

Like test_publish_release.py these read the script rather than run it: a
rehearsal needs a signing key and a ten-minute build, neither of which belongs in
a test run. What is checkable here is that the properties whose loss produces no
error message are still in place — and, for this script specifically, that it
cannot quietly become a way to publish.
"""

import json
import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPT = (REPOSITORY / "scripts" / "rehearse_update.ps1").read_text(encoding="utf-8")
RELEASE = (REPOSITORY / "scripts" / "publish_release.ps1").read_text(encoding="utf-8")
CONFIG = json.loads(
    (REPOSITORY / "dashboard" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
)


def test_rehearsal_never_runs_the_authenticode_gate():
    """Not an oversight to be fixed later. Skipping Authenticode is the point:
    it is the scarce signature, and the update mechanism does not involve it."""
    assert "verify_release.ps1" not in SCRIPT


def test_rehearsal_artifacts_announce_themselves():
    """The one thing standing between a rehearsal installer and somebody's
    machine is that it says what it is, loudly, at both ends of the run."""
    assert "REHEARSAL BUILD — NOT FOR RELEASE" in SCRIPT
    assert "Do not hand these artifacts to anyone" in SCRIPT


def test_release_script_did_not_acquire_a_gate_bypass():
    """The reason this is a second file. A -SkipSignatureGate switch on the real
    release script would eventually be used on a real release."""
    assert not re.search(r"\$SkipSignature|\$NoSign|\$Rehearsal", RELEASE)


def test_update_signature_is_regenerated_before_the_manifest_is_written():
    """Same ordering the release path enforces, for the same reason: a signature
    computed before the final bytes existed describes something nobody will
    download, and nothing says so until a client refuses the update."""
    sign = SCRIPT.index("npm run tauri -- signer sign")
    manifest = SCRIPT.index("$manifest = [ordered]@{")
    verify = SCRIPT.index("verify_update_signature.mjs")
    assert sign < manifest < verify


def test_both_paths_verify_the_manifest_before_declaring_success():
    """The check that turns a silent client-side failure into a local one. It is
    only worth having if neither path can reach its closing summary without it."""
    for script, done in ((SCRIPT, "Rehearsal $Version staged."), (RELEASE, "Release $version prepared.")):
        verify = script.index("verify_update_signature.mjs")
        assert verify < script.index(done)
        # And the failure has to stop the run rather than print and continue.
        tail = script[verify : script.index(done)]
        assert "throw" in tail


def test_manifest_platform_key_matches_the_only_target_time_ships():
    """Tauri looks the running platform up by this exact key; a typo produces an
    empty manifest entry and a silent 'no update available' forever."""
    assert "windows-x86_64" in SCRIPT
    assert re.search(r'"nsis"', json.dumps(CONFIG["bundle"]["targets"]))


def test_placeholder_guard_matches_the_shipped_placeholder():
    """A rehearsal run against the placeholder key would prove nothing: the
    installed copy verifies against whatever is baked into it."""
    placeholder = CONFIG["plugins"]["updater"]["pubkey"]
    if placeholder != "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY":
        assert "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY" in SCRIPT
        return
    assert placeholder in SCRIPT


def test_pinned_build_environment_leads_path():
    """The documented trap: the beforeBundleCommand invokes a bare `python`, and
    the first one on the release machine lacks winrt. A sidecar built by it drops
    media detection silently, which reads as a code regression."""
    assert "tracker-build-env" in SCRIPT
    prepend = re.search(r'\$env:PATH = "\$buildEnv;\$env:PATH"', SCRIPT)
    assert prepend, "the pinned environment must lead PATH, not trail it"


def test_packaged_sidecar_is_checked_rather_than_the_build_log():
    """The pin guard inspects the interpreter; this inspects what got packaged.
    They disagree exactly when it matters."""
    assert "_winrt_windows_media_control*.pyd" in SCRIPT
