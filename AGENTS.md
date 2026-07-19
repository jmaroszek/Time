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
python -m pytest -q                 # tracker + scripts  (98 tests)
cd dashboard && npx vitest run      # dashboard logic    (89 tests)
cd dashboard && npx tsc --noEmit    # typecheck
cd dashboard/src-tauri && cargo test  # Rust backend     (4 tests)
```

CI runs the first three (the dashboard suite twice, under two timezones,
because date handling is timezone-sensitive). **It does not run `cargo test`** —
run it locally when you touch `src-tauri/`.

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
