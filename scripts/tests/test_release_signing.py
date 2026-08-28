"""Static contracts for the release Authenticode evidence chain.

The real path spends three cloud signatures and builds an installer, so CI
cannot execute it. These checks keep Tauri, the signing wrapper, the publisher,
and the verifier wired to the same evidence model.
"""

import json
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPTS = REPOSITORY / "scripts"
CONFIG = json.loads(
    (REPOSITORY / "dashboard" / "src-tauri" / "tauri.conf.json").read_text(
        encoding="utf-8"
    )
)
SIGNER = (SCRIPTS / "sign_release_artifact.ps1").read_text(encoding="utf-8")
PUBLISH = (SCRIPTS / "publish_release.ps1").read_text(encoding="utf-8")
VERIFY = (SCRIPTS / "verify_release.ps1").read_text(encoding="utf-8")


def test_tauri_signing_runs_through_the_evidence_wrapper():
    command = CONFIG["bundle"]["windows"]["signCommand"]
    assert command["cmd"] == "pwsh"
    file_argument = command["args"][command["args"].index("-File") + 1]
    configured_signer = REPOSITORY / "dashboard" / "src-tauri" / file_argument
    assert configured_signer.resolve() == (SCRIPTS / "sign_release_artifact.ps1").resolve()
    assert configured_signer.is_file()
    assert command["args"].count("%1") == 1


def test_wrapper_refuses_to_spend_a_signature_without_fresh_evidence_context():
    context_check = SIGNER.index("TIME_RELEASE_SIGNING_EVIDENCE_DIR")
    signer_call = SIGNER.index("& artifact-signing-cli")
    assert context_check < signer_call
    assert "TIME_RELEASE_BUILD_ID" in SIGNER[context_check:signer_call]


def test_wrapper_captures_every_executable_boundary_and_checks_the_timestamp():
    for kind in ('"app"', '"tracker"', '"installer"'):
        assert kind in SIGNER
    assert "Get-AuthenticodeSignature" in SIGNER
    assert "TimeStamperCertificate" in SIGNER
    assert "ExpectedPublisherName" in SIGNER
    assert "Copy-Item" in SIGNER


def test_fresh_release_clears_stale_artifacts_and_uses_one_build_id():
    build = PUBLISH.index("npm run tauri build")
    assert PUBLISH.index("Remove-Item -LiteralPath $bundleDir", 0, build) < build
    assert PUBLISH.index("Remove-Item -LiteralPath $evidenceDirectory", 0, build) < build
    assert PUBLISH.index("TIME_RELEASE_BUILD_ID", 0, build) < build
    verify = PUBLISH.index('verify_release.ps1") -Installer $installer')
    assert "-ExpectedBuildId $buildId" in PUBLISH[verify : verify + 200]


def test_official_build_prevents_a_presigned_tracker_from_bypassing_capture():
    build = PUBLISH.index("npm run tauri build")
    clear = PUBLISH.index("Remove-Item Env:TIME_SIGN_COMMAND", 0, build)
    restore = PUBLISH.index("$env:TIME_SIGN_COMMAND = $previousTrackerSignCommand", build)
    assert clear < build < restore


def test_verifier_uses_captured_shipping_evidence_not_restored_build_copies():
    assert 'Join-Path $EvidenceDirectory "Time.exe"' in VERIFY
    assert 'Join-Path $EvidenceDirectory "time-tracker.exe"' in VERIFY
    assert 'Join-Path $releaseDir "Time.exe"' not in VERIFY
    assert 'Join-Path $releaseDir "time-tracker.exe"' not in VERIFY
    assert "MAINBINARYSRCPATH" in VERIFY
    assert 'oname=time-tracker\\.exe' in VERIFY
    assert "Post-build target/release/Time.exe (not a shipping gate)" in VERIFY


def test_verifier_binds_all_records_to_one_build_and_the_final_installer():
    assert "Select-Object -Unique" in VERIFY
    assert "ExpectedBuildId" in VERIFY
    assert "ExpectedPublisherName" in VERIFY
    assert "Assert-RecordMatchesFile -Record $installerRecord" in VERIFY
    assert "Assert-SamePath -Actual $installerRecord.sourcePath" in VERIFY


def test_verifier_checks_signature_before_reading_certificate_details():
    status_check = VERIFY.index('if ($signature.Status -ne "Valid")')
    certificate_check = VERIFY.index('if (-not $signature.SignerCertificate')
    name_read = VERIFY.index("$signature.SignerCertificate.GetNameInfo(")

    assert status_check < certificate_check < name_read
