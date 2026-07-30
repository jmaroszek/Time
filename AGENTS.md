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
cd dashboard/src-tauri && cargo test  # named Rust backend tests
cd dashboard && npm run test:device   # renderer, Chromium
cd dashboard && npm run build:native-device
cd dashboard && npm run test:native:doctor && npm run test:native  # see below
```

CI runs everything except `test:native` (the dashboard suite twice, under two
timezones, because date handling is timezone-sensitive; `cargo test`, the debug
application build, packaged-tracker scratch smoke, and the deterministic
renderer suite). **Any cargo command builds the tracker sidecar first**: the
Tauri build script fails if `externalBin` — `src-tauri/binaries/` — is missing,
so CI runs `scripts/build_tracker.py` before the Rust steps, and locally you
need it built once too.

**`test:native` cannot run on a hosted Windows runner.** WebView2 opens no
remote debugging port there, so msedgedriver fails every session with
`DevToolsActivePort file doesn't exist` and no test executes. Run it on a real
Windows desktop before a release; it is the only end-to-end check of window
state save/restore and off-screen recovery. The doctor must print
`ENVIRONMENT_READY` before WebdriverIO starts. A failure is then classified as
`ENVIRONMENT_BLOCKED` (the harness/session never became usable) or
`APP_FAILURE` (a Time assertion failed); either blocks release.

It also builds nothing: the script prepares a demo database and starts
WebdriverIO against `src-tauri/target/debug/Time.exe`, so
`npm run build:native-device` has to run first (and the sidecar before that, or
the Tauri build script stops on the missing `externalBin`).

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
