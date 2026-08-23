// Capture the website's approved Time screenshots from the real debug WebView.
//
// The dashboard must be launched against synthetic data with WebView2's local
// CDP port enabled. From the repository root:
//
//   $env:TIME_DB_PATH = "$PWD/data/demo.db"
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   Push-Location dashboard
//   npm run tauri dev
//
// Then, from another terminal in dashboard/:
//
//   node scripts/capture_screenshots.mjs
//   node scripts/capture_screenshots.mjs --theme light
//   node scripts/capture_screenshots.mjs --only insights-hero-week,insights-timeline-week-tooltip
//
// The ignored data/website-screenshots/<theme> directory receives native-DPR
// PNG captures. The script never opens the production database; TIME_DB_PATH
// belongs to the debug app that it attaches to, and should always name an
// explicit demo database.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const THEME = (argumentValue("--theme") ?? "dark").toLowerCase();
if (!new Set(["dark", "light"]).has(THEME)) {
  throw new Error("--theme must be dark or light");
}
const OUT_DIR = path.resolve(
  process.env.TIME_SCREENSHOT_OUT
    ?? path.join(REPO_ROOT, "data", "website-screenshots", THEME),
);
const CDP_URL = process.env.TIME_SCREENSHOT_CDP_URL ?? "http://127.0.0.1:9222";
const CAPTURE_TIME = process.env.TIME_SCREENSHOT_TIME ?? "2026-08-16T13:55:00-05:00";
const onlyValue = argumentValue("--only");
const ONLY = onlyValue !== null
  ? new Set(onlyValue.split(",").filter(Boolean))
  : null;

if (ONLY?.size === 0) throw new Error("--only requires a comma-separated list of asset names");
const requested = (name) => ONLY === null || ONLY.has(name);

mkdirSync(OUT_DIR, { recursive: true });

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

async function waitForActivity() {
  await page.getByRole("button", { name: "Activity", exact: true }).waitFor();
  await page.getByRole("button", { name: "Apps & Websites", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await page.waitForTimeout(500);
}

async function selectMenu(label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await waitForInsights();
}

async function ensureTheme(theme) {
  if (await page.evaluate((value) => document.documentElement.dataset.theme === value, theme)) return;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const themeGroup = page.getByRole("radiogroup", { name: "Theme", exact: true });
  const themeLabel = theme[0].toUpperCase() + theme.slice(1);
  await themeGroup.getByRole("radio", { name: themeLabel, exact: true }).click();
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
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

async function writeCapture(name, locator, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  if (!options.preserveHover) await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const capture = await locator.screenshot({ animations: "disabled" });
  const outputPath = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(outputPath, capture);
  console.log(`captured ${name}: ${outputPath}`);
}

async function writeScreenCapture(name, contentBounds = null) {
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  let master;
  if (contentBounds) {
    const shellBounds = await page.locator(".time-shell").boundingBox();
    const content = await contentBounds.boundingBox();
    if (!shellBounds || !content) throw new Error(`${name} capture bounds are unavailable`);
    master = await page.screenshot({
      animations: "disabled",
      captureBeyondViewport: true,
      clip: {
        x: shellBounds.x,
        y: shellBounds.y,
        width: content.x + content.width - shellBounds.x,
        height: content.y + content.height - shellBounds.y,
      },
    });
  } else {
    master = await page.locator(".time-shell").screenshot({ animations: "disabled" });
  }
  const outputPath = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(outputPath, master);
  console.log(`captured ${name}: ${outputPath}`);
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
const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
await ensureTheme(THEME);
const viewport = await page.evaluate(() => ({
  width: window.innerWidth,
  height: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
}));
console.log(
  `capturing ${THEME} theme from maximized WebView at ${viewport.width}x${viewport.height} CSS px, DPR ${viewport.devicePixelRatio}`,
);

// Preserve the maximized desktop layout in the source capture. Capture
// automation never narrows or zooms the app itself.
if (requested("insights-hero-week")) {
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
  writeFileSync(path.join(OUT_DIR, "insights-hero-week.png"), heroMaster);
  console.log("captured insights-hero-week");
}

if (requested("insights-timeline-week-tooltip")) {
  const timeline = cardByTitle("Timeline");
  await showTooltip(timeline, { x: 0.5, y: 0.45 });
  await writeCapture(
    "insights-timeline-week-tooltip",
    timeline,
    { preserveHover: true },
  );
}

const quarterRequested = [
  "insights-calendar-quarter-tooltip",
  "insights-rhythm-quarter-tooltip",
  "insights-weekly-hours-quarter",
  "insights-weekly-hours-quarter-categories",
].some(requested);
if (quarterRequested) await selectMenu("Date range preset", "Quarter");

if (requested("insights-calendar-quarter-tooltip")) {
  const calendar = cardByTitle("Activity Calendar");
  await showTooltip(calendar, { x: 0.55, y: 0.5 });
  await writeCapture(
    "insights-calendar-quarter-tooltip",
    calendar,
    { preserveHover: true },
  );
}

if (requested("insights-rhythm-quarter-tooltip")) {
  await selectMenu("Aggregate view", "Rhythm");
  const rhythm = cardByTitle("Activity Rhythm");
  await showTooltip(rhythm, { x: 0.5, y: 0.45 });
  await writeCapture(
    "insights-rhythm-quarter-tooltip",
    rhythm,
    { preserveHover: true },
  );
}

if (requested("insights-weekly-hours-quarter")) {
  const quarterHours = cardByTitle("Weekly Hours");
  await writeCapture("insights-weekly-hours-quarter", quarterHours);
}

if (requested("insights-weekly-hours-quarter-categories")) {
  await selectMenu("Stack bars by", "Categories");
  const quarterCategories = cardByTitle("Weekly Hours");
  await writeCapture(
    "insights-weekly-hours-quarter-categories",
    quarterCategories,
  );
  await selectMenu("Stack bars by", "Productivity");
}

const weekRankingRequested = requested("insights-top-apps-week")
  || requested("insights-top-websites-week");
if (quarterRequested && weekRankingRequested) {
  await selectMenu("Date range preset", "Week");
}

if (requested("insights-top-apps-week")) {
  const topApps = cardByTitle("Top Apps");
  await writeCapture("insights-top-apps-week", topApps);
}

if (requested("insights-top-websites-week")) {
  await selectMenu("Ranked activity type", "Websites");
  const topWebsites = cardByTitle("Top Websites");
  await writeCapture("insights-top-websites-week", topWebsites);
  await selectMenu("Ranked activity type", "Apps");
}

if (quarterRequested && !weekRankingRequested) {
  // Leave the debug app in its default rolling-week state even when a selective
  // run only needed a quarter view for one capture.
  await selectMenu("Date range preset", "Week");
}

const activityRequested = requested("activity-apps-websites-week")
  || requested("activity-categories-rules-work-expanded");
if (activityRequested) {
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await waitForActivity();
}

if (requested("activity-apps-websites-week")) {
  await page.getByRole("button", { name: "Apps & Websites", exact: true }).click();
  await page.getByRole("columnheader", { name: "Name", exact: true }).waitFor();
  await page.locator(".overflow-auto").evaluateAll((nodes) => {
    for (const node of nodes) node.scrollTop = 0;
  });
  await writeScreenCapture("activity-apps-websites-week");
}

if (requested("activity-categories-rules-work-expanded")) {
  await page.getByRole("button", { name: "Categories & Rules", exact: true }).click();
  await page.getByText("Rules classify matching historical and future activity.").waitFor();

  // Make this deterministic if the debug session had retained expansion state:
  // close every category first, then open only Work.
  const expandedCategories = page.getByRole("button", { name: /^Collapse .+ rules$/ });
  while (await expandedCategories.count()) await expandedCategories.first().click();
  await page.getByRole("button", { name: "Expand Work rules", exact: true }).click();
  await page.getByRole("button", { name: "Collapse Work rules", exact: true }).waitFor();
  await page.locator(".overflow-auto").evaluateAll((nodes) => {
    for (const node of nodes) node.scrollTop = 0;
  });
  const rulesSurface = page
    .getByRole("button", { name: "Categories & Rules", exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'max-w-[800px]')][1]");
  await writeScreenCapture("activity-categories-rules-work-expanded", rulesSurface);
}

if (activityRequested) {
  await page.getByRole("button", { name: "Insights", exact: true }).click();
  await waitForInsights();
}

if (originalTheme !== THEME && new Set(["dark", "light"]).has(originalTheme)) {
  await ensureTheme(originalTheme);
}

console.log(`website screenshots are ready in ${OUT_DIR}`);
process.exit(0);
