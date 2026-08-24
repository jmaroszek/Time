// Runs a repository Python script under a deliberately chosen interpreter.
//
// `python` on PATH is not a stable identity on a Windows development machine.
// Anaconda puts its base environment first, the Microsoft Store installs an
// execution-alias stub that is not an interpreter at all, and a fresh shell can
// have none of them. The tracker build cares which one it gets — the sidecar
// must be packaged by the pinned environment or it ships without the winrt
// media extension — and the utility scripts only care that they get a working
// one. Both problems are the same problem: nobody should have to arrange PATH
// correctly before a build will run.
//
// The order below is the single definition of "the right interpreter" for npm
// entry points. `find_python.ps1` implements the same order for the PowerShell
// release scripts; a five-line ordered list duplicated in two languages is
// cheaper than making a Python-artifact checker depend on Node. Change one and
// change the other.
//
//   1. TIME_PYTHON                       — explicit override, always wins
//   2. data/tracker-build-env/Scripts    — the pinned build environment
//   3. `python` on PATH                  — what CI's setup-python provides
//   4. `py -3`                           — the Windows launcher
//
// Usage: node scripts/run_python.mjs <script.py> [args...]
//        node scripts/run_python.mjs --print-interpreter

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED = join(REPOSITORY, "data", "tracker-build-env", "Scripts", "python.exe");

/** Does this candidate actually start and report a Python 3 version?
 *
 * Presence on disk is not enough. The Store's `python.exe` alias under
 * WindowsApps is a launcher stub that opens the Store rather than running code,
 * so it is rejected by path before it is ever executed — running it to find out
 * would pop the Store window at the reader. */
function works(command, prefixArgs = []) {
  if (/[\\/]WindowsApps[\\/]/i.test(command)) return false;
  const probe = spawnSync(command, [...prefixArgs, "-c", "import sys; print(sys.version_info[0])"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return probe.status === 0 && probe.stdout.trim() === "3";
}

function resolveInterpreter() {
  const override = process.env.TIME_PYTHON;
  if (override) {
    if (!works(override)) {
      throw new Error(`TIME_PYTHON is set to '${override}', which is not a working Python 3.`);
    }
    return { command: override, args: [], source: "TIME_PYTHON" };
  }
  if (existsSync(PINNED) && works(PINNED)) {
    return { command: PINNED, args: [], source: "pinned build environment" };
  }
  if (works("python")) {
    return { command: "python", args: [], source: "PATH" };
  }
  if (works("py", ["-3"])) {
    return { command: "py", args: ["-3"], source: "py launcher" };
  }
  throw new Error(
    "No usable Python 3 interpreter found. Looked at, in order:\n" +
      "  1. $TIME_PYTHON                (unset)\n" +
      `  2. ${PINNED}\n` +
      "     (create it: py -3 -m venv data\\tracker-build-env)\n" +
      "  3. `python` on PATH\n" +
      "  4. `py -3`\n" +
      "Install Python 3, or point TIME_PYTHON at an interpreter.",
  );
}

let interpreter;
try {
  interpreter = resolveInterpreter();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const argv = process.argv.slice(2);

if (argv[0] === "--print-interpreter") {
  console.log(interpreter.command);
  process.exit(0);
}

if (argv.length === 0) {
  console.error("usage: node scripts/run_python.mjs <script.py> [args...]");
  process.exit(1);
}

// `inherit` rather than a captured pipe: callers tee this output and read exit
// codes from it, so the child has to own the real stdout and stderr handles.
const result = spawnSync(interpreter.command, [...interpreter.args, ...argv], {
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`Could not run ${interpreter.command}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
