import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(here, "src-tauri", "target", "debug", "Time.exe");
process.env.TIME_DB_PATH ??= path.resolve(here, "..", "data", "device-compat.db");

export const config = {
  runner: "local",
  specs: ["./device-test/native/**/*.spec.mjs"],
  exclude: [],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: binary,
      },
    },
  ],
  // Quiet locally; CI raises this so a failed session handshake is diagnosable.
  logLevel: process.env.WDIO_LOG_LEVEL ?? "warn",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  // A retried session start replaces the driver's real refusal with a generic
  // timeout, which hid a "DevToolsActivePort file doesn't exist" failure.
  connectionRetryCount: 0,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: binary,
        driverProvider: "external",
        autoInstallTauriDriver: true,
        autoDownloadEdgeDriver: true,
        startTimeout: 90_000,
        commandTimeout: 60_000,
        // Capture stdout and WebView console output through the external
        // driver. Time does not ship a production WebDriver plugin.
        captureBackendLogs: true,
        captureFrontendLogs: true,
        backendLogLevel: "info",
        frontendLogLevel: "warn",
        logDir: path.join(here, "test-results", "native"),
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  outputDir: "./test-results/native",
  before: () => {
    // This hook runs only after WebdriverIO has created the Tauri/WebView2
    // session, and before Mocha executes any of the three native assertions.
    console.log("DRIVER_HANDSHAKE_READY: WebView2 automation session established.");
  },
  afterTest: async (_test, _context, result) => {
    if (result.passed) return;
    const safeName = _test.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    await browser.saveScreenshot(
      path.join(here, "test-results", "native", `${safeName}.png`),
    ).catch(() => undefined);
  },
};
