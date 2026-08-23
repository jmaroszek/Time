# Contributing to Time

Pull requests are welcome. Two things are worth knowing before you spend time on
one.

## Open an issue first

For anything beyond an obvious fix, open an issue before writing code. Time is a
single-author product with opinions about how it behaves, and an issue is the
cheap place to find out that a change conflicts with one of them. Bug reports
and reproductions are valuable on their own — you do not need to bring a patch.

## Contributions need a license grant

Time is commercial software. The source is published for inspection, not
licensed for use, and it has to stay licensable by its owner — which means the
owner must hold the rights to everything in it. Code contributed without that
grant cannot be merged, however good it is.

By opening a pull request you confirm that:

- you wrote the contribution yourself, or have the right to submit it;
- you grant Jonah Maroszek an irrevocable, worldwide, royalty-free right to use,
  modify, sublicense, and distribute your contribution as part of Time, under
  any license, including commercial ones; and
- you are not entitled to payment, royalties, revenue share, equity, or any
  other compensation for it — now or at any point later — and expect no
  attribution beyond the commit history.

Time is sold commercially, and a merged contribution becomes part of a product
its owner charges money for. Contributing creates no ownership stake, no claim
on revenue, and no expectation of future payment.

Say so in the pull request description. If you cannot agree to that, please
still open an issue describing the change — a good description is often most of
the work anyway.

## Running the checks

Every CI gate has a local equivalent. From the repository root:

```powershell
python -m coverage run -m pytest -q tracker/tests scripts/tests
```

The dashboard suites must run from `dashboard/`, not the repository root —
Vitest resolves its config from the working directory, and from the root it also
collects the Playwright specs it cannot run and reports unrelated failures:

```powershell
cd dashboard
npm install
npm run test                                          # dashboard logic
npx tsc --noEmit                                      # typecheck
npm run test:device                                   # deterministic renderer
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Any Cargo command that compiles runs Tauri's build script, which needs the
tracker sidecar under `src-tauri/binaries/`. Build it once first — see
[README.md](README.md#building-from-source). `cargo fmt` does not compile and
needs no sidecar.

Install the repository hooks once per clone:

```powershell
git config core.hooksPath .githooks
```

That gets two. `pre-commit` runs rustfmt on staged Rust so a commit cannot fail
CI on formatting alone. `commit-msg` strips `Co-Authored-By` trailers naming a
coding agent — Time has one accountable owner, and a commit written under your
direction is yours. Trailers naming a *person* are left alone; the hook matches
addresses, never names, so a real co-author never loses credit.

The Rust toolchain is pinned in [rust-toolchain.toml](rust-toolchain.toml)
because rustfmt's output changes between releases. Do not replace it with
rolling `stable`.

**Never run anything against `%LOCALAPPDATA%\Time\Data\database.db`.** That is
somebody's real history. Tests, migration exercises, and demo runs take an
explicit scratch path. `py scripts/make_demo_db.py` writes a synthetic database
you can point a debug build at with `TIME_DB_PATH`.

## Invariants that are easy to break by accident

The two halves of Time share a database and nothing else, so several facts are
deliberately written down in more than one place. Changing one copy and not the
others produces a failure on a user's machine rather than at build time.

- **The tracker owns recorded sessions and migrations.** It alone creates or
  edits `sessions` rows and alone migrates the schema. The dashboard deletes
  history only through fixed Rust commands and stores user corrections
  separately. The SQL allowlist in `dashboard/src-tauri/src/database.rs`
  enforces the boundary.
- **The schema exists twice.** `_SCHEMA` in `tracker/db.py` and `BOOTSTRAP_SQL`
  in `database.rs` must stay equivalent, because either runtime may create a new
  database first.
- **A schema bump touches three files.** `SCHEMA_VERSION` in `tracker/db.py`,
  `SCHEMA_VERSION` and the `('schema_version','N')` bootstrap literal in
  `database.rs`, and `SUPPORTED_SCHEMA_VERSION` in
  `dashboard/src/lib/schema.ts`.
- **Setting defaults and setting ranges are separate contracts.** Defaults are
  mirrored by `DEFAULT_SETTINGS` in `tracker/db.py` and `BOOTSTRAP_SQL` in
  `database.rs`. Ranges are mirrored by `get_settings` in `tracker/db.py` and
  `SPECS` in `dashboard/src/tabs/SettingsTab.tsx`.
- **Window titles and browser domains must never reach INFO logs.**
  `tracker/tests/test_logging.py` verifies this against real writes.
- **Chart colors come from mirrored tokens** in
  `dashboard/src/lib/chartTheme.ts` and `dashboard/src/index.css`. ECharts
  cannot read CSS variables; do not add hex literals to components.
- **The updater's manifest endpoint stays constant.** A Tauri URL template would
  put each user's version in server logs beside their IP address.

## Style

Match the surrounding code. Comments explain *why* — the invariant, constraint,
or failure behind the implementation — not what the next line does, and not what
the commit history already records.

## Security

Please do not open a normal issue for an exploitable vulnerability. See
[SECURITY.md](SECURITY.md) for private reporting.
