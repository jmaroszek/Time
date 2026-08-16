// Capture the website's approved Time screenshots from the real debug WebView.
//
// The dashboard must be launched against synthetic data with WebView2's local
// CDP port enabled. From the repository root:
//
//   $env:TIME_DB_PATH = "$PWD/data/demo-full.db"
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   Push-Location dashboard
//   npm run tauri dev
//
// Then, from another terminal in dashboard/:
//
//   node scripts/capture_screenshots.mjs
//
// The ignored data/website-screenshots directory receives full component
// masters and exact-ratio website derivatives. The script never opens the
// production database; TIME_DB_PATH belongs to the debug app that it attaches
// to, and should always name an explicit demo database.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const OUT_DIR = path.resolve(
  process.env.TIME_SCREENSHOT_OUT ?? path.join(REPO_ROOT, "data", "website-screenshots"),
);
const MASTER_DIR = path.join(OUT_DIR, "masters");
const WEB_DIR = path.join(OUT_DIR, "web");
const DESIGN_CROP_DIR = path.join(OUT_DIR, "design-crops");
const CDP_URL = process.env.TIME_SCREENSHOT_CDP_URL ?? "http://127.0.0.1:9222";
const CAPTURE_TIME = process.env.TIME_SCREENSHOT_TIME ?? "2026-08-16T13:55:00-05:00";

mkdirSync(MASTER_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });
mkdirSync(DESIGN_CROP_DIR, { recursive: true });

const browser = await chromium.connectOverCDP(CDP_URL);
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
const page = pages.find((candidate) => candidate.url().includes("localhost:1420"));
if (!page) {
  throw new Error(`Dashboard page not found on ${CDP_URL}. Is the debug WebView running?`);
}
page.setDefaultTimeout(120_000);

async function waitForInsights() {
  await page.getByRole("button", { name: "Insights", exact: true }).waitFor();
  await page.locator("p").filter({ hasText: "Daily productive time" }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await page.locator('[data-insights-chart="true"] canvas').first().waitFor();
  await page.waitForTimeout(700);
}

async function selectMenu(label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await waitForInsights();
}

async function ensureDarkTheme() {
  if (await page.evaluate(() => document.documentElement.dataset.theme === "dark")) return;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const theme = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await theme.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.getByRole("button", { name: "Insights", exact: true }).click();
  await waitForInsights();
}

function cardByTitle(title) {
  return page
    .locator("h2")
    .filter({ hasText: title })
    .first()
    .locator("xpath=../..");
}

async function resizePng(buffer, width, height, fit = "cover") {
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  const output = await page.evaluate(
    async ({ source, targetWidth, targetHeight, mode }) => {
      const response = await fetch(source);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas is unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";

      const scale = mode === "contain"
        ? Math.min(targetWidth / bitmap.width, targetHeight / bitmap.height)
        : Math.max(targetWidth / bitmap.width, targetHeight / bitmap.height);
      const drawWidth = bitmap.width * scale;
      const drawHeight = bitmap.height * scale;
      const x = (targetWidth - drawWidth) / 2;
      const y = (targetHeight - drawHeight) / 2;
      context.fillStyle = "#1f2227";
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.drawImage(bitmap, x, y, drawWidth, drawHeight);
      bitmap.close();
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { source: dataUrl, targetWidth: width, targetHeight: height, mode: fit },
  );
  return Buffer.from(output, "base64");
}

async function resizePngToWidth(buffer, width) {
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  const output = await page.evaluate(
    async ({ source, targetWidth }) => {
      const response = await fetch(source);
      const bitmap = await createImageBitmap(await response.blob());
      const targetHeight = Math.round(bitmap.height * targetWidth / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas is unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      bitmap.close();
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { source: dataUrl, targetWidth: width },
  );
  return Buffer.from(output, "base64");
}

async function writeCapture(name, locator, webSize, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const master = await locator.screenshot({ animations: "disabled" });
  const masterPath = path.join(MASTER_DIR, `${name}.png`);
  writeFileSync(masterPath, master);

  const web = await resizePngToWidth(master, webSize.width);
  const webPath = path.join(WEB_DIR, `${name}.png`);
  writeFileSync(webPath, web);

  const designCrop = await resizePng(
    master,
    webSize.width,
    webSize.height,
    options.fit ?? "cover",
  );
  const designCropPath = path.join(DESIGN_CROP_DIR, `${name}.png`);
  writeFileSync(designCropPath, designCrop);
  console.log(`captured ${name}: ${masterPath} -> ${webPath}`);
}

async function visibleChartTooltip(chart) {
  return chart.locator("div").evaluateAll((nodes) => {
    for (const node of nodes) {
      const style = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (
        style.position === "absolute"
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0
        && bounds.width > 40
        && bounds.height > 20
        && text.length > 3
      ) {
        return text;
      }
    }
    return null;
  });
}

async function showTooltip(card, preferred = { x: 0.55, y: 0.5 }) {
  const chart = card.locator('[data-insights-chart="true"]');
  const bounds = await chart.boundingBox();
  if (!bounds) throw new Error("Chart bounds are unavailable");

  const candidates = [
    preferred,
    { x: 0.45, y: 0.45 },
    { x: 0.62, y: 0.38 },
    { x: 0.35, y: 0.58 },
    { x: 0.72, y: 0.62 },
  ];
  for (let y = 0.2; y <= 0.8; y += 0.1) {
    for (let x = 0.18; x <= 0.82; x += 0.08) candidates.push({ x, y });
  }

  for (const point of candidates) {
    await page.mouse.move(bounds.x + bounds.width * point.x, bounds.y + bounds.height * point.y);
    await page.waitForTimeout(90);
    const text = await visibleChartTooltip(chart);
    if (text) {
      await page.waitForTimeout(250);
      console.log(`tooltip: ${text}`);
      return;
    }
  }
  throw new Error("Unable to expose an ECharts tooltip for the requested capture");
}

try {
  await page.clock.install({ time: new Date(CAPTURE_TIME) });
} catch (error) {
  if (!String(error).includes("already installed")) throw error;
}
await page.reload({ waitUntil: "domcontentloaded" });
// install() starts with time paused. Resume from the fixed instant so React,
// workers, chart animation frames, and delayed tooltips can all settle.
await page.clock.resume();
await page.addStyleTag({
  content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      caret-color: transparent !important;
    }
  `,
});
await waitForInsights();
await ensureDarkTheme();
const viewport = await page.evaluate(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
}));
console.log(
  `capturing maximized WebView at ${viewport.width}x${viewport.height} CSS px, DPR ${viewport.devicePixelRatio}`,
);

// Preserve the maximized desktop layout in the source capture. The website's
// 16:10 derivative is made afterward; capture automation never narrows or
// zooms the app itself.
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(500);
const shellBounds = await page.locator(".time-shell").boundingBox();
const bottomCardBounds = await cardByTitle("Top Apps").boundingBox();
if (!shellBounds || !bottomCardBounds) throw new Error("Hero capture bounds are unavailable");
const heroMaster = await page.screenshot({
  animations: "disabled",
  captureBeyondViewport: true,
  clip: {
    x: shellBounds.x,
    y: shellBounds.y,
    width: shellBounds.width,
    height: bottomCardBounds.y + bottomCardBounds.height - shellBounds.y + 16,
  },
});
writeFileSync(path.join(MASTER_DIR, "insights-hero-week.png"), heroMaster);
writeFileSync(
  path.join(WEB_DIR, "insights-hero-week.png"),
  await resizePngToWidth(heroMaster, 2176),
);
writeFileSync(
  path.join(DESIGN_CROP_DIR, "insights-hero-week.png"),
  await resizePng(heroMaster, 2176, 1360, "cover"),
);
console.log("captured insights-hero-week");

const timeline = cardByTitle("Timeline");
await showTooltip(timeline, { x: 0.5, y: 0.45 });
await writeCapture("insights-timeline-week-tooltip", timeline, { width: 800, height: 600 });

await selectMenu("Date range preset", "Quarter");
const calendar = cardByTitle("Activity Calendar");
await showTooltip(calendar, { x: 0.55, y: 0.5 });
await writeCapture("insights-calendar-quarter-tooltip", calendar, { width: 800, height: 600 });

await selectMenu("Aggregate view", "Rhythm");
const rhythm = cardByTitle("Activity Rhythm");
await showTooltip(rhythm, { x: 0.5, y: 0.45 });
await writeCapture("insights-rhythm-quarter-tooltip", rhythm, { width: 800, height: 600 });

const quarterHours = cardByTitle("Weekly Hours");
await writeCapture("insights-weekly-hours-quarter", quarterHours, { width: 520, height: 520 });

await selectMenu("Date range preset", "Week");
const topApps = cardByTitle("Top Apps");
await writeCapture("insights-top-apps-week", topApps, { width: 520, height: 520 });

console.log(`website screenshots are ready in ${OUT_DIR}`);
process.exit(0);
