import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "..", "..");

function run(command, args) {
  return spawnSync(command, args, {
    cwd: dashboard,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
}

const doctor = run("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  path.join(here, "doctor.ps1"),
]);
process.stdout.write(doctor.stdout ?? "");
process.stderr.write(doctor.stderr ?? "");
if (doctor.status !== 0) {
  console.error("ENVIRONMENT_BLOCKED: native preflight did not pass.");
  process.exit(doctor.status ?? 1);
}

// Invoke the JavaScript entry point directly. Passing the generated wdio.cmd
// shim through cmd.exe adds another quoting layer on Windows, and paths with
// spaces can then be interpreted as a literal quoted command.
const wdioPath = path.join(
  dashboard,
  "node_modules",
  "@wdio",
  "cli",
  "bin",
  "wdio.js",
);
const wdio = run(process.execPath, [
  wdioPath,
  "run",
  "wdio.native.conf.mjs",
]);
process.stdout.write(wdio.stdout ?? "");
process.stderr.write(wdio.stderr ?? "");
if (wdio.status === 0) {
  console.log("APP_COMPATIBILITY_PASSED: native assertions completed.");
  process.exit(0);
}

const output = `${wdio.stdout ?? ""}\n${wdio.stderr ?? ""}`;
// The WDIO hook emits this marker only after the Tauri/WebView2 session is
// usable. Any earlier failure belongs to the environment or harness; only a
// failure after the marker can implicate Time's assertions.
const appSessionStarted = output.includes("DRIVER_HANDSHAKE_READY:");
console.error(
  appSessionStarted
    ? "APP_FAILURE: the native app session started and a compatibility assertion failed."
    : "ENVIRONMENT_BLOCKED: WebView2/WebDriver did not establish an app session.",
);
process.exit(wdio.status ?? 1);
