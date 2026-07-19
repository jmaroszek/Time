// Screenshot every dashboard tab into docs/images/ via the WebView2 CDP port.
//
// Usage (from repo root):
//   1. py scripts/make_demo_db.py
//   2. in dashboard/:  TIME_DB_PATH=<repo>/Data/demo.db
//      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//      npm run tauri dev
//   3. cd dashboard && npm i --no-save puppeteer-core
//      node scripts/capture_screenshots.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "images",
);
const TABS = ["Overview", "Trends", "Apps", "Settings"];

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: null,
});
const pages = await browser.pages();
const page = pages.find((p) => p.url().includes("localhost:1420"));
if (!page) throw new Error("dashboard page not found on the CDP port");

mkdirSync(OUT_DIR, { recursive: true });
for (const tab of TABS) {
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll("header button")].find(
      (b) => b.textContent.trim() === label,
    );
    if (!btn) throw new Error(`tab button not found: ${label}`);
    btn.click();
  }, tab);
  await new Promise((r) => setTimeout(r, 2000)); // data load + chart animation
  const file = path.join(OUT_DIR, `${tab.toLowerCase()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`captured ${file}`);
}
await browser.disconnect();
