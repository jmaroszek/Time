# Windows signing for public releases

Public Time releases must sign and timestamp all three executable boundaries:

1. `time-tracker-<target-triple>.exe` after the PyInstaller sidecar build;
2. `Time.exe` after the Rust release build;
3. the final NSIS installer.

Use an Authenticode code-signing identity issued to the publisher. Keep private
keys and service credentials out of this repository. Tauri supports a local
certificate thumbprint, a custom `signCommand`, Azure Key Vault, and Azure
Artifact Signing; follow the current
[official Windows signing guide](https://v2.tauri.app/distribute/sign/windows/)
for the selected provider. Configure SHA-256 and the timestamp service supplied
by that provider.

The sidecar is produced during Tauri's `beforeBundleCommand`. If the selected
Tauri signing path does not sign external binaries automatically, sign the
sidecar immediately after `npm run build:tracker` and before NSIS bundling. Do
not sign source-controlled files or commit a certificate, PFX, password,
thumbprint tied to a private identity, tenant secret, or signing-service token.

After building, run:

```powershell
pwsh -File scripts/verify_release.ps1 `
  -Installer dashboard/src-tauri/target/release/bundle/nsis/Time_0.1.0_x64-setup.exe
```

The verifier infers the corresponding dashboard and x64 tracker paths, requires
valid timestamped signatures on all three artifacts, and prints their SHA-256
hashes. For another architecture, pass `-TrackerExecutable` explicitly. Never
publish an artifact when this gate fails.
