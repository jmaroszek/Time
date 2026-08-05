# AGENTS.md

Working notes for AI agents and new contributors. [README.md](README.md)
describes what Time does and why; this file covers what is easy to get wrong.

## Layout

Two halves that never call each other. They meet at one SQLite file
(`%LOCALAPPDATA%\Time\time_log.db`, WAL mode), and that file is the contract.

```
tracker/      Python, always on. Win32 probe -> session rows.
dashboard/    Tauri 2 + React. Reads sessions; writes only categories,
              rules, and settings.
scripts/      Build, demo-data, and database-health tooling.
docs/         Public product documentation.
docs/personal/  Owner-only working documents. Git-ignored. See below.
```

## Commands

Run from the repository root unless noted.

```
python -m coverage run -m pytest -q tracker/tests scripts/tests
python -m coverage report           # tracker + scripts branch-coverage gate
cd dashboard && npm run test:coverage  # dashboard logic + V8 branch coverage
cd dashboard && npx tsc --noEmit    # typecheck
cd dashboard && cargo test --manifest-path src-tauri/Cargo.toml  # Rust backend
cd dashboard && npm run test:device   # renderer, Chromium
cd dashboard && npm run build:debug-app  # links the whole application
scripts/smoke_packaged_tracker.ps1 -TrackerExecutable <sidecar> -OutputDirectory <scratch>
```

**Every gate above runs on a developer machine.** A check that only runs on the
runner cannot be rehearsed before it is merged, and the packaged smoke shipped
two failures in a row while it was restricted to CI. Keep it that way: give a
new check an isolation argument rather than an environment test.

`cargo test` is serialized by `RUST_TEST_THREADS` in `/.cargo/config.toml` — at
the repository root because cargo resolves that file from the working
directory, and CI runs cargo from `dashboard/`. The restore tests swap files
underneath an open database; in parallel they failed about one run in six.

Run it from `dashboard/` to match CI. The test scratch root is built from
`std::env::current_dir()`, so a different working directory puts scratch
databases somewhere else — harmless, but it is one less difference to reason
about when something only fails in one place.

CI runs every gate above (the dashboard suite twice, under two timezones,
because date handling is timezone-sensitive; `cargo test`, the debug
application build, packaged-tracker scratch smoke, and the deterministic
renderer suite). **Any cargo command builds the tracker sidecar first**: the
Tauri build script fails if `externalBin` — `src-tauri/binaries/` — is missing,
so CI runs `scripts/build_tracker.py` before the Rust steps, and locally you
need it built once too.

**Window state save/restore has no end-to-end gate.** A WebDriver suite covered
it until 2026-07-31 and was deleted: WebView2 opens no remote debugging port on
a hosted runner, so it could only ever run by hand, and two of its four checks
asserted against a window it drove with `SetWindowPos` from outside Tauri —
which the window-state plugin never observes, so they failed against a working
app. The unit tests in `src-tauri/src/window_state.rs` cover the clamping and
off-screen recovery logic; the clean-VM checklist covers the rest by eye. Do not
rebuild an automated replacement without a failure it would have caught.

Build the tracker from the dedicated, git-ignored `data/tracker-build-env`
environment. Reusing a broad Conda or development environment can expose
unrelated PyInstaller hooks and native packages to the build. The builder also
refuses mismatched runtime packages rather than producing an unreproducible
sidecar.

```powershell
python -m venv data\tracker-build-env
data\tracker-build-env\Scripts\python -m pip install -r tracker\requirements-build.txt
data\tracker-build-env\Scripts\python scripts\build_tracker.py
```

The builder starts the bundle once against a scratch profile and fails rather
than emitting a sidecar that cannot run. A conda interpreter keeps the DLLs its
extension modules link against in `Library\bin` instead of beside the modules,
so the build puts that directory on PATH; without it the bundle builds cleanly
and then dies on its first `import ctypes`.

Both halves default the database to `%LOCALAPPDATA%\Time\time_log.db`, creating
it on first run. Debug dashboard builds accept `TIME_DB_PATH`; the tracker uses
`TIME_DATA_DIR`. Release builds ignore database-path overrides.

```powershell
py scripts/make_demo_db.py     # writes data/demo.db, ~12 weeks of fake life
$env:TIME_DB_PATH = "$PWD/data/demo.db"; cd dashboard; npm run tauri dev
```

Before shipping an artifact, complete the owner-run clean-VM release checklist on
Windows 10 and Windows 11 — automated source checks do not replace that evidence
— and give invited testers the [beta invite note](docs/beta-invite.md) with the
build's SHA-256 hash filled in. During a beta soak, run
`scripts/check_db_anomalies.py` weekly against an explicit database path or a
fresh backup: it opens SQLite read-only, runs `integrity_check`, and reports
duration, AFK-identity, overlap, rule, foreign-key, and schema-contract
violations. Exit code 0 means every check passed; `--json` is machine-readable.

## Branches

**Work on the checked-out branch — normally `main` — and do not create a branch
unless the owner asks for one.** Size of the change is not a reason to branch;
ask if you think one is warranted.

## Personal documents

`docs/personal/` is the home for owner-only material: audits, roadmaps,
checklists, release runbooks, competitive notes, and agent-created planning
documents. It is git-ignored by a single rule and never ships.

- Put new planning or audit documents there. Do not invent a new ignored path,
  and do not add a per-file `.gitignore` rule — the directory rule covers it.
- `docs/` itself is public product documentation written for users.
- **Never move an existing document into or out of `docs/personal/` without
  the owner's approval.** Ask; the classification is theirs, not yours.

Because that directory is invisible to anyone reading the published repo,
**nothing in tracked source may cite it** — no audit IDs (`SUP-001`,
`DATA-002`), no "see the audit" pointers. If a private document explains why
code is the way it is, write the reason into the comment instead. A citation
nobody can resolve is worse than no comment.

## Conventions worth knowing

- **The tracker owns writes to `sessions` and owns all schema migrations.** The
  dashboard reads sessions and never migrates. The Rust backend enforces this:
  see the SQL allowlist in `dashboard/src-tauri/src/database.rs`.
- **The schema is duplicated** in `tracker/db.py` (`_SCHEMA`) and
  `database.rs` (`BOOTSTRAP_SQL`), because either half may create the database
  first. Change both or neither.
- **The schema version is declared in four places**, and a bump has to reach
  every one: `SCHEMA_VERSION` in `tracker/db.py`, `SCHEMA_VERSION` in
  `database.rs`, the `('schema_version','N')` literal inside its
  `BOOTSTRAP_SQL`, and `SUPPORTED_SCHEMA_VERSION` in
  `dashboard/src/lib/schema.ts`. Only the tracker migrates; the other three are
  refusals, so a missed one does not fail loudly at build time — it rejects a
  database the tracker has already upgraded, on the user's machine.
- **Settings defaults are mirrored in three places**: `DEFAULT_SETTINGS`
  (`tracker/db.py`), `BOOTSTRAP_SQL` (`database.rs`), and the clamp ranges in
  `dashboard/src/tabs/SettingsTab.tsx`. Comments at each site say so.
- **Privacy is enforced by tests, not by convention.** Window titles and
  browser domains must never reach an INFO log line.
  `tracker/tests/test_logging.py` drives real writes and fails if they do.
  Title capture is opt-in and off by default, and browser URLs are stripped
  before storage.
- **Charts use the tokens in `dashboard/src/lib/chartTheme.ts` and
  `dashboard/src/index.css`** — ECharts
  cannot read CSS variables, so the values are mirrored there deliberately.
  No new hex literals in components.
- **Check `git status` after adding files.** Ignore patterns have hidden real
  source in this repo before; anchor new rules (`/Images/`, not `Images/`).

## Style

Match the surrounding code. Comments explain *why* — the invariant, the
constraint, the failure that motivated the shape — and never restate what the
line already says or narrate a change that git history records.
