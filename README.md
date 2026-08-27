# Time

A local-first time tracker for Windows that answers one question: **how do I
spend time on my computer?**

A small Python tracker runs in the background after explicit consent and records
foreground-app timing to SQLite. A Tauri 2 + React dashboard turns that into
answers — how much you worked, on what, and how it is changing.

**[trackwithtime.com](https://trackwithtime.com)** is the place to see what Time
does: features, screenshots, and the guides for using it. This repository is the
place to verify the website's claims.

## Why this repository is public

A time tracker asks for a lot of trust. It sees every application you open, and
optionally every window title. Being able to read the code and confirm the
privacy claims is worth more than any wording on a privacy page.

This is why the source is published for *inspection.* It is not licensed for use — see
[LICENSE.md](LICENSE.md).

## What you can check here

These are the claims the website makes. Each one is verifiable in a few minutes:

| Claim | Where to check it |
| --- | --- |
| The updater is the only feature that touches the network | `dashboard/src/` contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon`; `tracker/` imports no HTTP client; the only networking crate in [Cargo.toml](dashboard/src-tauri/Cargo.toml) is `tauri-plugin-updater` |
| The update check carries no identifier or activity data | The endpoint is a fixed static manifest in [tauri.conf.json](dashboard/src-tauri/tauri.conf.json); no URL template means no per-user version in anyone's server logs |
| Browser URLs are reduced to a domain before storage | [tracker/domains.py](tracker/domains.py) strips path, query, fragment, port, and credentials in memory |
| Window titles are off until you turn them on | `DEFAULT_SETTINGS` in [tracker/db.py](tracker/db.py) |
| Titles and domains never reach the log file | [tracker/tests/test_logging.py](tracker/tests/test_logging.py) asserts it against real writes |
| The webview cannot reach your filesystem or pick a database | The capability set in [capabilities/default.json](dashboard/src-tauri/capabilities/default.json) and the CSP in [tauri.conf.json](dashboard/src-tauri/tauri.conf.json) |
| The dashboard cannot run arbitrary SQL | The statement allowlist in [database.rs](dashboard/src-tauri/src/database.rs) |

[SECURITY.md](SECURITY.md) has the full threat model, the limits of local
storage, and how to report a vulnerability privately.

## Architecture

```
tracker/    Python, always on. Win32 foreground/idle probe -> session rows.
dashboard/  Tauri 2 + React + ECharts, launched on demand. Reads sessions;
            owns categories, rules, and settings.
scripts/    Build, demo-data, and database-health tooling.
```

The two halves never talk to each other. One SQLite database in WAL mode at
`%LOCALAPPDATA%\Time\Data\database.db` is the entire contract between them, and
both resolve that fixed per-user path independently. Settings the dashboard
writes are re-read by the tracker on its next heartbeat. Both verify
`schema_version` and refuse unsafe writes.

## Building from source

The license permits building Time to verify that a release matches this source.
You need Windows, Python 3.13, Node 24, and the Rust toolchain pinned in
[rust-toolchain.toml](rust-toolchain.toml).

Build the tracker sidecar from a dedicated environment. A broad Conda or
development environment exposes unrelated PyInstaller hooks and native packages
to the build, and the builder rejects runtime packages that do not match
`tracker/requirements.txt`:

```powershell
python -m venv data\tracker-build-env
data\tracker-build-env\Scripts\python -m pip install -r tracker\requirements-build.txt
data\tracker-build-env\Scripts\python scripts\build_tracker.py
```

Then build the application and installer:

```powershell
cd dashboard
npm install
npm run tauri build
```

The installer lands in `dashboard/src-tauri/target/release/bundle/nsis/`. It is
unsigned; official releases are Authenticode-signed and timestamped, so a
locally built installer will not match a published one byte for byte. Compare
behavior and source, not hashes.

## Contributing

Pull requests are welcome, with one condition: contributions need a copyright
assignment or license grant, because Time is commercial software and has to stay
licensable by its owner. [CONTRIBUTING.md](CONTRIBUTING.md) covers that, how to
run the tests, and the few invariants that are easy to break by accident.

## License

Time is commercial software. This source is published for inspection, not
licensed for use. Reading it and compiling it to verify a release are permitted;
installing and running Time comes with a copy supplied by its author. See
[LICENSE.md](LICENSE.md).
