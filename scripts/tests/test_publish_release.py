"""Guards on the release script's two silent-failure modes.

These read the script rather than run it: publishing needs a signing key, a
network destination, and a real build, none of which belong in a test run. What
can be checked here is that the two properties whose loss produces no error
message are still in place.
"""

import json
import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SCRIPT = (REPOSITORY / "scripts" / "publish_release.ps1").read_text(encoding="utf-8")
CONFIG = json.loads(
    (REPOSITORY / "dashboard" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
)


def test_placeholder_guard_matches_the_shipped_placeholder():
    """A renamed placeholder would leave the guard looking for a string that no
    longer exists, and a build would go out advertising updates no client can
    verify."""
    placeholder = CONFIG["plugins"]["updater"]["pubkey"]
    if placeholder != "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY":
        # The real key is in place on this machine; the guard is then moot.
        assert "REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY" in SCRIPT
        return
    assert placeholder in SCRIPT


def test_update_signature_is_regenerated_after_the_authenticode_gate():
    """The ordering the whole script exists to enforce. Authenticode rewrites
    the installer, so a signature produced before that gate describes bytes
    nobody will download — and the failure appears only on user machines."""
    # Anchored on the statements, not on prose: the prologue names all three.
    verify = SCRIPT.index('& (Join-Path $PSScriptRoot "verify_release.ps1")')
    sign = SCRIPT.index("npm run tauri -- signer sign")
    manifest = SCRIPT.index("$manifest = [ordered]@{")
    assert verify < sign < manifest


def test_version_parity_runs_before_release_artifact_selection():
    """A stale component version must stop publication before a build or
    installer path can be selected."""
    parity = SCRIPT.index('"check_version_parity.py"')
    artifact_selection = SCRIPT.index('$bundleDir = Join-Path $releaseDir')
    config_selection = SCRIPT.index('$configPath = Join-Path $srcTauri')
    assert parity < config_selection < artifact_selection
    assert "version parity check failed" in SCRIPT[parity:config_selection]


def test_manifest_platform_key_matches_the_only_target_time_ships():
    """Tauri looks the running platform up by this exact key; a typo produces an
    empty manifest entry and a silent 'no update available' forever."""
    assert "windows-x86_64" in SCRIPT
    assert re.search(r'"nsis"', json.dumps(CONFIG["bundle"]["targets"]))


def test_download_base_url_is_mandatory():
    """The installer URL is signed along with the rest of the manifest, so a
    wrong one cannot be corrected without re-signing. A default would let the
    wrong value ship silently -- which is exactly what the old default
    (/updates, the manifest's path rather than the installer's) would have
    done."""
    params = SCRIPT[SCRIPT.index("param("):SCRIPT.index("$ErrorActionPreference")]
    base_url = params.index("$DownloadBaseUrl")
    assert "[Parameter(Mandatory = $true)]" in params[:base_url], (
        "DownloadBaseUrl must stay mandatory"
    )
    assert not re.search(r"\$DownloadBaseUrl\s*=", params), (
        "DownloadBaseUrl must not have a default value"
    )


def test_manifest_destination_comes_from_the_compiled_endpoint():
    """Installed copies poll plugins.updater.endpoints and nothing else, so the
    upload destination the script prints has to be read from there rather than
    derived from -DownloadBaseUrl, which addresses the installer and is a
    different path in production. Conflating them publishes a correct manifest
    to an address no client reads, and the release looks successful."""
    assert "$config.plugins.updater.endpoints" in SCRIPT
    upload = SCRIPT.index('Write-Host "Upload, in this order:"')
    tail = SCRIPT[upload:]
    assert "$manifestEndpoint" in tail, (
        "the printed manifest destination must be the compiled endpoint"
    )
    assert "DownloadBaseUrl" not in tail, (
        "the manifest destination must not be derived from -DownloadBaseUrl"
    )
