import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.resolve(here, "..", "..", "src-tauri", "target", "debug", "Time.exe");
const windowControl = path.join(here, "window_control.ps1");
const windowStatePath = path.join(
  process.env.APPDATA ?? "",
  "io.github.jmaroszek.time.device-compat",
  ".window-state.json",
);

function controlNativeWindow(action, values = {}) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    windowControl,
    "-Action",
    action,
    "-Binary",
    appBinary,
  ];
  for (const [key, value] of Object.entries(values)) {
    args.push(`-${key}`, String(value));
  }
  return JSON.parse(execFileSync("powershell.exe", args, { encoding: "utf8" }));
}

async function setNativeWindowRect(x, y, width, height) {
  const scale = await browser.execute(() => window.devicePixelRatio);
  controlNativeWindow("restore");
  controlNativeWindow("set", {
    X: Math.round(x * scale),
    Y: Math.round(y * scale),
    Width: Math.round(width * scale),
    Height: Math.round(height * scale),
  });
  await browser.pause(250);
  return { rect: controlNativeWindow("get"), scale };
}

async function waitForDashboard() {
  try {
    await browser.waitUntil(
      () => browser.execute(
        () => [...document.querySelectorAll("button")]
          .some((button) => button.textContent?.trim() === "Insights"),
      ),
      { timeout: 30_000, timeoutMsg: "dashboard navigation did not become ready" },
    );
  } catch (error) {
    // Without this the failure says only that navigation never appeared, which
    // is true of a crashed webview, an onboarding screen, and a renamed tab
    // alike. Report what the window actually held.
    const state = await browser.execute(() => ({
      url: location.href,
      title: document.title,
      buttons: [...document.querySelectorAll("button")]
        .map((button) => button.textContent?.trim())
        .filter(Boolean)
        .slice(0, 20),
      text: document.body?.innerText?.trim().slice(0, 600) ?? "",
    })).catch((reason) => ({ unreachable: String(reason) }));
    error.message += `\nwindow contents: ${JSON.stringify(state, null, 2)}`;
    throw error;
  }
}

async function closeAndReload() {
  const clicked = await browser.execute(() => {
    const close = document.querySelector('button[aria-label="Close"]');
    close?.click();
    return close !== null;
  });
  assert.equal(clicked, true, "native close control was not available");
  await browser.waitUntil(
    async () => {
      try {
        return (await browser.getWindowHandles()).length === 0;
      } catch {
        return true;
      }
    },
    { timeout: 5_000, timeoutMsg: "native window did not close cleanly" },
  );
  // The window disappears before Tauri's RunEvent::Exit finishes flushing the
  // Rust-only cache to disk.
  await browser.pause(500);
  const persisted = JSON.parse(readFileSync(windowStatePath, "utf8")).main;
  await browser.reloadSession();
  await waitForDashboard();
  return persisted;
}

describe("native Windows device compatibility", () => {
  before(async () => {
    await waitForDashboard();
  });

  it("resizes the isolated Win32 host to snap-equivalent bounds", async () => {
    for (const [width, height] of [
      [500, 480],
      [640, 480],
      [960, 540],
      [1008, 640],
    ]) {
      const { rect, scale } = await setNativeWindowRect(80, 80, width, height);
      assert.ok(
        Math.abs(rect.width / scale - width) <= 16,
        JSON.stringify({ expected: { width, height }, rect, scale }),
      );
      assert.ok(
        Math.abs(rect.height / scale - height) <= 16,
        JSON.stringify({ expected: { width, height }, rect, scale }),
      );
    }
  });

  it("restores ordinary and maximized state across native sessions", async () => {
    const ordinary = await setNativeWindowRect(120, 100, 960, 540);
    const persistedOrdinary = await closeAndReload();
    const restored = controlNativeWindow("get");
    assert.ok(Math.abs(restored.width - ordinary.rect.width) <= ordinary.scale * 16, JSON.stringify({
      ordinary,
      persistedOrdinary,
      restored,
    }));
    assert.ok(Math.abs(restored.height - ordinary.rect.height) <= ordinary.scale * 16, JSON.stringify({
      ordinary,
      persistedOrdinary,
      restored,
    }));

    const maximized = controlNativeWindow("maximize");
    await closeAndReload();
    const restoredMaximized = controlNativeWindow("get");
    assert.ok(restoredMaximized.width >= maximized.width - ordinary.scale * 16, JSON.stringify({
      maximized,
      restoredMaximized,
    }));
    assert.ok(restoredMaximized.height >= maximized.height - ordinary.scale * 16, JSON.stringify({
      maximized,
      restoredMaximized,
    }));
  });

  it("recovers a wholly off-screen saved position", async () => {
    await setNativeWindowRect(-20_000, -20_000, 900, 600);
    await closeAndReload();
    const rect = controlNativeWindow("get");
    assert.ok(rect.x + rect.width > 0, JSON.stringify(rect));
    assert.ok(rect.y + rect.height > 0, JSON.stringify(rect));
  });
});
