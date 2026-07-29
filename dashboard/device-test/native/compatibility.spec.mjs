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

async function setRendererWindowSize(width, height) {
  // External EdgeDriver maintains an independently controllable WebView
  // viewport. Renderer assertions use it; persistence assertions separately
  // control the exact isolated Win32 host window above.
  await browser.setWindowSize(width, height);
  await browser.waitUntil(
    async () => {
      const viewport = await browser.execute(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      return Math.abs(viewport.width - width) <= 16
        && Math.abs(viewport.height - height) <= 16;
    },
    { timeout: 5_000, timeoutMsg: `native window did not resize to ${width}x${height}` },
  );
}

async function waitForDashboard() {
  await browser.waitUntil(
    () => browser.execute(
      () => [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.trim() === "Insights"),
    ),
    { timeout: 30_000, timeoutMsg: "dashboard navigation did not become ready" },
  );
}

async function waitForSelector(selector, timeout = 15_000) {
  await browser.waitUntil(
    () => browser.execute(
      (value) => document.querySelector(value) !== null,
      selector,
    ),
    { timeout, timeoutMsg: `${selector} did not become available` },
  );
}

async function clickButton(label) {
  const clicked = await browser.execute((value) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === value);
    button?.click();
    return button !== undefined;
  }, label);
  assert.equal(clicked, true, `button "${label}" was not available`);
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

async function layoutReport() {
  return browser.execute(() => {
    const appViewport = document.querySelector(".app-viewport");
    const clientRight = appViewport
      ? appViewport.getBoundingClientRect().left + appViewport.clientWidth
      : window.innerWidth;
    const scopes = [
      document.documentElement,
      document.body,
    ].filter(Boolean);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      appViewport: appViewport
        ? {
            clientWidth: appViewport.clientWidth,
            offsetWidth: appViewport.offsetWidth,
            scrollWidth: appViewport.scrollWidth,
          }
        : null,
      charts: [...document.querySelectorAll("canvas")].map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const card = canvas
          .closest('div[class*="rounded-[14px]"]')
          ?.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          cardLeft: card?.left ?? 0,
          cardRight: card?.right ?? window.innerWidth,
        };
      }),
      viewportOffenders: appViewport
        ? [...appViewport.querySelectorAll("*")]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== "none"
                && style.visibility !== "hidden"
                && rect.width > 1
                && (rect.left < -1 || rect.right > clientRight + 1);
            })
            .slice(0, 8)
            .map((node) => ({
              className: node.className,
              rect: node.getBoundingClientRect().toJSON(),
              tag: node.tagName,
            }))
        : [],
      overflowing: scopes
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => ({
          name: node === document.documentElement
            ? "html"
            : node === document.body
              ? "body"
              : node.className,
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        })),
    };
  });
}

function assertNoOverflow(report, context = "") {
  assert.deepEqual(report.overflowing, [], `${context}${JSON.stringify(report)}`);
  // WebView2's classic vertical scrollbar makes scrollWidth two pixels wider
  // than clientWidth even with overflow-x hidden. A descendant beyond the
  // scrollport is the user-visible failure; the empty list distinguishes that
  // engine bookkeeping from real horizontal layout overflow.
  assert.deepEqual(report.viewportOffenders, [], `${context}${JSON.stringify(report)}`);
  for (const chart of report.charts) {
    assert.ok(chart.width > 0 && chart.height > 0, `${context}${JSON.stringify(report)}`);
    assert.ok(chart.left >= chart.cardLeft - 1, `${context}${JSON.stringify(report)}`);
    assert.ok(chart.right <= chart.cardRight + 1, `${context}${JSON.stringify(report)}`);
  }
}

describe("native Windows device compatibility", () => {
  before(async () => {
    await waitForDashboard();
  });

  it("supports snap-equivalent window sizes without horizontal overflow", async () => {
    for (const [width, height] of [
      [500, 480],
      [640, 480],
      [960, 540],
      [1008, 640],
    ]) {
      await setRendererWindowSize(width, height);
      const report = await layoutReport();
      assertNoOverflow(report);
      assert.ok(report.viewport.width >= 500);
      assert.ok(report.viewport.height >= 448);
    }
  });

  it("keeps every primary tab reachable at the minimum size", async () => {
    await setRendererWindowSize(500, 480);
    for (const label of ["Insights", "Activity", "Settings"]) {
      await clickButton(label);
      const report = await layoutReport();
      assertNoOverflow(report, `${label}: `);
    }

    await clickButton("Activity");
    await waitForSelector("tbody button");
    await browser.execute(() => document.querySelector("tbody button")?.click());
    await waitForSelector("aside");
    assertNoOverflow(await layoutReport(), "Activity detail: ");
    const returned = await browser.execute(() => {
      const back = document.querySelector('button[aria-label="Back to Activity list"]');
      back?.click();
      return back !== null;
    });
    assert.equal(returned, true, "Activity Back control was not available");
    await waitForSelector("table");
    assert.equal(
      await browser.execute(
        () => document.querySelector("tbody button") === document.activeElement,
      ),
      true,
    );
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
