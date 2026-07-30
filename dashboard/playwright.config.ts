import { defineConfig } from "@playwright/test";

const matrixProjects = [
  { name: "layout-500x480", width: 500, height: 480, grep: /@matrix|@minimum/ },
  { name: "layout-640x480", width: 640, height: 480, grep: /@matrix/ },
  { name: "layout-960x540", width: 960, height: 540, grep: /@matrix/ },
  { name: "layout-1008x640", width: 1008, height: 640, grep: /@matrix|@settle/ },
  { name: "layout-1366x768", width: 1366, height: 768, grep: /@matrix/ },
  { name: "layout-1920x1080", width: 1920, height: 1080, grep: /@matrix/ },
  { name: "layout-2208x1242", width: 2208, height: 1242, grep: /@matrix/ },
];

export default defineConfig({
  testDir: "./device-test/specs",
  outputDir: "./test-results/device",
  globalSetup: "./device-test/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI
    ? [
        ["list"],
        ["json", { outputFile: "test-results/device/results.json" }],
        ["html", { outputFolder: "playwright-report", open: "never" }],
      ]
    : "list",
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:1422",
    browserName: "chromium",
    colorScheme: "dark",
    locale: "en-US",
    // Every rendered date derives from the fixed clock in the specs, but the
    // clock is an instant: only a pinned zone maps it to the same calendar day
    // on a local run and on the UTC CI runner. Without this the baselines
    // capture whichever week the capturing machine's offset happened to land
    // in, and the suite fails on the other side.
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    ...matrixProjects.map(({ name, width, height, grep }) => ({
      name,
      grep,
      use: { viewport: { width, height }, deviceScaleFactor: 1 },
    })),
    {
      name: "960x540-dpr2",
      grep: /@matrix|@dpr/,
      use: { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 },
    },
    {
      name: "workflow-1008x640",
      grep: /@workflow/,
      use: { viewport: { width: 1008, height: 640 }, deviceScaleFactor: 1 },
    },
  ],
});
