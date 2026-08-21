"""Checks the update-signature verifier against real `tauri signer` output.

The fixture is genuine: a throwaway keypair was generated with
`npm run tauri signer generate`, used to sign `payload.bin`, and its public half
and signature committed here. Only the public half exists in this repository, so
nothing about it is sensitive, and it is not the release keypair.

Signing the fixture inside the test would be worse than useless — the generator
and the verifier would share one understanding of the minisign format, so a
mistaken one would still pass. Frozen output from the real CLI is the only thing
that can tell us the verifier agrees with what actually gets published.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

REPOSITORY = Path(__file__).resolve().parents[2]
VERIFIER = REPOSITORY / "scripts" / "verify_update_signature.mjs"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "update_signature"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="the verifier is a Node script, so without Node there is nothing to test",
)


def read_key(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8").strip()


def verify(target: Path, pubkey: str, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(VERIFIER), str(target), "--pubkey", pubkey, *extra],
        capture_output=True,
        text=True,
        cwd=REPOSITORY,
    )


def test_accepts_a_real_tauri_signature():
    """The baseline. If this fails, every other assertion here is meaningless."""
    result = verify(FIXTURES / "payload.bin", read_key("pubkey.txt"))
    assert result.returncode == 0, result.stderr
    assert "Update signature verified." in result.stdout
    # tauri signs the Blake2b-512 hash rather than the file. A CLI that switched
    # to plain "Ed" would still verify, but we want to notice the change.
    assert "Algorithm : ED" in result.stdout


def test_rejects_a_file_whose_bytes_changed_after_signing(tmp_path):
    """The failure this script exists for: Authenticode, a repack, or a rebuild
    that was not re-signed. Nothing else in the release pipeline notices."""
    tampered = tmp_path / "payload.bin"
    original = (FIXTURES / "payload.bin").read_bytes()
    tampered.write_bytes(original[:-2] + b"!\n")
    shutil.copy(FIXTURES / "payload.bin.sig", tmp_path / "payload.bin.sig")

    result = verify(tampered, read_key("pubkey.txt"))
    assert result.returncode == 1
    assert "bytes changed after it was signed" in result.stderr


def test_rejects_a_signature_from_a_different_keypair():
    """The trap when the keypair is first set up: an installed build verifies
    against the pubkey baked into it, so signing a rehearsal with a second key
    produces an update every client silently refuses."""
    result = verify(FIXTURES / "payload.bin", read_key("foreign-pubkey.txt"))
    assert result.returncode == 1
    assert "different keypairs" in result.stderr


def test_rejects_the_configuration_placeholder():
    """A build shipped with the placeholder still in it can never be updated.
    Saying so beats a parse error nobody can read."""
    result = verify(FIXTURES / "payload.bin", "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY")
    assert result.returncode == 1
    assert "placeholder" in result.stderr


def test_rejects_a_manifest_naming_a_different_installer(tmp_path):
    """A manifest hand-edited from a previous release keeps the old signature and
    the old URL. Both halves have to describe the file being published."""
    manifest = tmp_path / "latest.json"
    manifest.write_text(
        '{"version":"0.1.1","platforms":{"windows-x86_64":'
        f'{{"signature":"{(FIXTURES / "payload.bin.sig").read_text(encoding="utf-8").strip()}",'
        '"url":"https://example.invalid/updates/Time_0.1.0_x64-setup.exe"}}}',
        encoding="utf-8",
    )
    result = verify(FIXTURES / "payload.bin", read_key("pubkey.txt"), "--manifest", str(manifest))
    assert result.returncode == 1
    assert "manifest points at" in result.stderr


def test_verifies_the_signature_carried_by_a_manifest(tmp_path):
    """Clients read the manifest, never the .sig file beside the installer, so
    the manifest's copy is the one worth checking."""
    payload = tmp_path / "payload.bin"
    shutil.copy(FIXTURES / "payload.bin", payload)
    manifest = tmp_path / "latest.json"
    manifest.write_text(
        '{"version":"0.1.1","platforms":{"windows-x86_64":'
        f'{{"signature":"{(FIXTURES / "payload.bin.sig").read_text(encoding="utf-8").strip()}",'
        '"url":"https://example.invalid/updates/payload.bin"}}}',
        encoding="utf-8",
    )
    result = verify(payload, read_key("pubkey.txt"), "--manifest", str(manifest))
    assert result.returncode == 0, result.stderr
    assert "Version   : 0.1.1" in result.stdout
