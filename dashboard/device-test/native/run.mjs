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

const wdioPath = path.join(dashboard, "node_modules", ".bin", "wdio.cmd");
const wdio = run(process.env.ComSpec ?? "cmd.exe", [
  "/d",
  "/s",
  "/c",
  `"${wdioPath}" run wdio.native.conf.mjs`,
]);
process.stdout.write(wdio.stdout ?? "");
process.stderr.write(wdio.stderr ?? "");
if (wdio.status === 0) {
  console.log("APP_COMPATIBILITY_PASSED: native assertions completed.");
  process.exit(0);
}

const output = `${wdio.stdout ?? ""}\n${wdio.stderr ?? ""}`;
const environmentFailure =
  /DevToolsActivePort|session not created|Failed to create session|ECONNREFUSED|driver.*not found/i
    .test(output);
console.error(
  environmentFailure
    ? "ENVIRONMENT_BLOCKED: WebView2/WebDriver did not establish an app session."
    : "APP_FAILURE: the native app session started and a compatibility assertion failed.",
);
process.exit(wdio.status ?? 1);
