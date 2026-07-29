import { defineConfig } from "@playwright/test";

const viewports = [
  { name: "500x480", width: 500, height: 480 },
  { name: "640x480", width: 640, height: 480 },
  { name: "960x540", width: 960, height: 540 },
  { name: "1008x640", width: 1008, height: 640 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "2208x1242", width: 2208, height: 1242 },
];

export default defineConfig({
  testDir: "./device-test/specs",
  outputDir: "./test-results/device",
  globalSetup: "./device-test/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.006,
      // Chromium and the bundled Inter fixture are identical across the local
      // Windows run and Linux CI, so keep one reviewable baseline rather than
      // accepting a second unreviewed platform copy.
      pathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:1422",
    browserName: "chromium",
    colorScheme: "dark",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    ...viewports.map(({ name, width, height }) => ({
      name,
      use: { viewport: { width, height }, deviceScaleFactor: 1 },
    })),
    {
      name: "960x540-dpr2",
      use: { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 },
    },
  ],
});
