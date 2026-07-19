# Production Roadmap

How to turn **Time** from a personal, repo-relative tool into a professional app
other people can install and use.

This is written against the current architecture, not a rewrite. The design is
already shipping-friendly: the tracker and dashboard never talk directly — the
SQLite database is the contract — and the schema bootstraps itself on first open
([db.py](tracker/db.py) `open_db`). Most of the work below is *relocation and
packaging*, not new core logic.

Each phase lists effort (Low / Med / High) and marks whether it's **required**
to ship at that tier or **optional** polish.

---

## TL;DR — three tiers

| Tier | Goal | Net effort | What it adds |
|---|---|---|---|
| **A. Shareable** | A few friends can install & run it | ~1–2 focused days | Per-user DB path, bundled tracker, one installer, autostart |
| **B. Trustworthy** | Strangers install without friction or fear | +2–4 days | Code signing, auto-update, onboarding, tray control |
| **C. Polished product** | Sustainable, supportable, credible | +ongoing | CI, diagnostics, privacy posture, release process |

You do **not** need B or C to reach A. Ship A first, learn from real users, then
climb.

---

## Phase 0 — Make it run on a machine that isn't yours *(the unblocker)*

> ✅ **DONE (2026-06-24).** Both halves now resolve the DB to
> `%LOCALAPPDATA%\Time\time_log.db`; existing history was migrated with
> `VACUUM INTO` and verified live in the Settings tab.

**Was: Required for Tier A. Effort: Low–Med. The linchpin — nothing else
mattered until it was done.**

Previously both halves resolved the DB path to *your* disk:

- Dashboard bakes it in **at build time** — [vite.config.ts:14](dashboard/vite.config.ts:14)
  freezes `C:\Users\jonah\...\Data\time_log.db` into the JS bundle as a constant
  ([db.ts:6](dashboard/src/lib/db.ts:6)).
- Tracker resolves it **repo-relative** — `ROOT / "Data" / "time_log.db"`
  ([config.py:7](tracker/config.py:7)).

Neither survives being installed elsewhere. The fix is to make both halves agree
on a **per-user location**: `%LOCALAPPDATA%\Time\time_log.db`.

**Work (all done):**
- [x] Tracker resolves `DB_PATH`/`LOG_PATH` from `LOCALAPPDATA` with a
      `TIME_DATA_DIR` override; repo-relative fallback only off Windows
      ([config.py](tracker/config.py)). `db.open_db` now creates the parent dir.
- [x] Dashboard resolves the path at runtime via a Rust `db_path` command
      ([lib.rs](dashboard/src-tauri/src/lib.rs)) that `db.ts` invokes;
      `VITE_DB_PATH` kept as a build-time override for the demo DB.
- [x] The `db_path` command `create_dir_all`s the folder before either half
      opens the DB; the schema self-creates the file on first open.
- [x] SQL plugin capability unchanged — `sql:allow-load` already permits an
      absolute path
      ([capabilities/default.json](dashboard/src-tauri/capabilities/default.json)).

**Why it was the whole ballgame:** once both sides point at the same per-user
file, the DB-as-contract design holds on any machine. Everything after this is
wiring.

---

## Phase 1 — Package as a single installable *(Tier A)*

**Required for Tier A. Effort: Med.** Assemble from pieces you already have. The
release build now deliberately targets one current-user NSIS installer, whose
lifecycle hooks cover the tracker sidecar.

> ✅ **IMPLEMENTED (2026-07-19).** The one-dir tracker is built automatically,
> bundled into the current-user NSIS installer, started immediately, and managed
> through an HKCU Run entry. The packaged executable tracked successfully against
> a scratch database; the two-OS clean-VM checklist remains the release gate.

- [x] **Bundle the tracker** with PyInstaller into a standalone `.exe` — no
      Python / pywin32 / psutil install required on the user's machine. (This is
      the bundling already discussed; it's the right call now that there's a
      reason to ship.)
- [x] **Carry the tracker inside the installer** as a Tauri sidecar /
      `externalBin` so one download delivers both halves.
- [x] **Autostart at logon:** installer drops an `HKCU\...\Run` entry (or a Task
      Scheduler task) pointing at the bundled tracker. Your single-instance
      mutex ([tracker.py:28](tracker/tracker.py:28)) already makes duplicate
      launches harmless.
- [x] **First-run:** start the tracker immediately after install, not just at
      next logon, so the app has data on first open.
- [x] **Uninstall cleanup:** remove the autostart entry and stop the tracker.
      Decide whether to keep the user's DB (recommended: keep it, like most
      apps) or offer "also delete my data."

**Outcome of Tier A:** a real installer a friend can run. SmartScreen will warn
"Unknown publisher" — for a handful of trusted users that's a one-time
"More info → Run anyway." Phase 3 removes that.

---

## Phase 2 — Trust & distribution *(Tier B)*

**Required for unattended/stranger installs. Effort: Med.**

- [ ] **Code signing.** Unsigned Windows apps trip SmartScreen. Options:
      - Azure Trusted Signing — cheapest, ~$10/mo, if you qualify.
      - Standard OV/EV cert — ~$100–400/yr.
      - EV builds SmartScreen reputation instantly; OV earns it over downloads.
      Sign **both** the installer and the bundled tracker exe.
- [ ] **Auto-update.** Adopt the Tauri updater plugin so users don't reinstall
      manually. Needs a hosted update manifest + signed release artifacts.
- [ ] **Release hosting & versioning.** GitHub Releases is the path of least
      resistance: tag → CI builds → signed artifacts + update manifest. Bump
      `version` in [tauri.conf.json](dashboard/src-tauri/tauri.conf.json) and
      keep the tracker version in lockstep.
- [ ] **Tracker auto-update story.** The sidecar updates with the app bundle;
      make sure an update cleanly restarts the running tracker.

---

## Phase 3 — Product polish & UX *(Tier B/C)*

**Mostly optional, but this is what makes it feel like a product. Effort: Med.**

- [ ] **System tray presence.** Right now the tracker is an invisible background
      process — users can't tell if it's running, pause it, or quit it. A tray
      icon with *running/paused status*, *pause tracking*, *open dashboard*, and
      *quit* closes the biggest "is this even working?" gap.
- [ ] **First-run onboarding.** One screen explaining what's tracked (foreground
      app + window title), that **data stays local**, and where the DB lives.
- [ ] **Health indicator in-app.** You already compute a live heartbeat check
      and show the DB path + session counts ([docs/settings.md](docs/settings.md)
      "Tracker & Database"). Surface a green/red "tracker is running" badge
      prominently, not just in Settings.
- [ ] **Empty states.** A fresh install has no data — make the first-open
      experience intentional rather than blank charts. (`make_demo_db.py` could
      seed an optional "try it with sample data" mode.)
- [ ] Settings are already UI-editable and re-read by the tracker each heartbeat
      — that's a real product strength; keep it.

---

## Phase 4 — Reliability & support *(Tier C)*

**Effort: Low–Med, high payoff once you have users you can't shoulder-tap.**

- [ ] **Crash resilience** is already partly handled — the heartbeat bounds data
      loss to `heartbeat_seconds` ([session_manager.py](tracker/session_manager.py)),
      and the tracker supervises its own loop. Document this guarantee.
- [ ] **Tracker watchdog.** If the tracker dies, autostart only recovers it at
      next logon. Consider a Task Scheduler "restart on failure" policy or a
      lightweight watchdog so a crash self-heals same-session.
- [ ] **Diagnostics export.** A one-click "export logs" (logs already rotate
      daily via `TimedRotatingFileHandler`) makes remote support possible.
- [ ] **Backup & data safety.** The `VACUUM INTO` backup already exists
      ([docs/settings.md](docs/settings.md)). For a shipped app, consider an
      automatic periodic backup and a documented restore path.
- [x] **Schema migration discipline.** The tracker owns numbered, transactional
      migrations and stamps `schema_version`; the dashboard only checks
      compatibility and refuses newer databases. The first fixture-backed
      migration adds session/rule constraints and cleans legacy anomalies.
      Legacy column backfills remain tracker-owned, and each future shipped
      schema must add one numbered step plus its prior-version fixture.

---

## Phase 5 — Engineering hygiene for a real release *(Tier C)*

**Effort: Low to set up, compounding value.**

- [ ] **CI.** You have real test suites — `pytest tracker/tests scripts/tests`
      and `vitest` ([README](README.md)). Wire them to run on every push, plus a
      build job that produces the signed installer on tag.
- [ ] **Cross-machine smoke test.** Install on a clean Windows VM with no Python
      and no repo — the truest test that Phase 0/1 actually worked.
- [ ] **License & repo hygiene.** Pick a license; scrub anything machine-specific
      before the repo goes public (there's already a public-prep effort in
      flight — fold this roadmap into it).
- [ ] **Telemetry decision.** Default to **none** for a privacy-sensitive tracker.
      If you ever add it, make it opt-in and local-first.

---

## Cross-cutting: privacy is a feature, not an afterthought

This app records **foreground window titles**, which routinely contain document
names, email subjects, URLs, and chat content. For a personal tool that's fine;
for something others install it's the single most important trust question.

- **Lead with "everything stays on your machine."** No cloud, no account, no
  upload — that's a genuine, marketable differentiator. Make it the first thing
  onboarding says.
- Consider a **title-redaction / app-only mode** for users who want app-level
  tracking without capturing titles.
- Never add network calls without an explicit, visible opt-in.

---

## The platform fork in the road

Time is **Windows-only by construction** — the input layer is `ctypes` +
`win32gui`/`win32process` over Win32 APIs ([win32_probe.py](tracker/win32_probe.py)),
including UWP child-window resolution. The session state machine and the entire
dashboard are platform-agnostic.

Going cross-platform (macOS/Linux) means **reimplementing only
`win32_probe.py`** per platform behind the existing `Snapshot` interface — a
contained, well-bounded effort thanks to the clean separation, but still a real
project (macOS needs Accessibility/`NSWorkspace` APIs and permission prompts).
Treat it as a deliberate Tier-C+ decision, not part of the initial ship.

---

## Recommended sequencing

1. **Phase 0** — relocate the DB path. Nothing works cross-machine without it.
2. **Phase 1** — PyInstaller + sidecar + installer + autostart → *Tier A, shareable.*
3. Get it onto 2–3 other people's machines. Fix what breaks. (Phase 5's clean-VM
   test belongs here.)
4. **Phase 3** tray + onboarding, then **Phase 2** signing + auto-update → *Tier B.*
5. **Phase 4 / 5** harden as the user count and your patience for support demand.

The architecture is already on your side — the DB-as-contract seam means you're
relocating one path and packaging an exe you already have, not untangling a
monolith. Phase 0 is the only step that touches core code; the rest is assembly.
