import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_PROCESSES,
  displayBrowserProcesses,
  normalizeBrowserProcesses,
} from "./browsers";

describe("DEFAULT_BROWSER_PROCESSES", () => {
  it("ships only the six supported mainstream Windows browsers", () => {
    expect(DEFAULT_BROWSER_PROCESSES).toBe(
      "chrome.exe,msedge.exe,firefox.exe,opera.exe,brave.exe,vivaldi.exe",
    );
  });
});

describe("normalizeBrowserProcesses", () => {
  it("supplies the extension the process list is matched on", () => {
    expect(normalizeBrowserProcesses("chrome, Firefox,msedge.exe")).toEqual([
      "chrome.exe",
      "firefox.exe",
      "msedge.exe",
    ]);
  });

  it("accepts a pasted install path", () => {
    expect(
      normalizeBrowserProcesses("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
    ).toEqual(["chrome.exe"]);
  });

  it("leaves a non-exe extension alone", () => {
    expect(normalizeBrowserProcesses("Safari.app")).toEqual(["safari.app"]);
  });

  it("drops blanks and duplicates that differ only in shape", () => {
    expect(normalizeBrowserProcesses(" chrome.exe , ,CHROME, ")).toEqual(["chrome.exe"]);
  });

  it("accepts several processes pasted on separate lines", () => {
    expect(normalizeBrowserProcesses("chrome\nfirefox.exe\r\nmsedge")).toEqual([
      "chrome.exe",
      "firefox.exe",
      "msedge.exe",
    ]);
  });

  it("presents executable names without leaking the internal suffix", () => {
    expect(displayBrowserProcesses("chrome.exe, Firefox, Safari.app")).toBe(
      "chrome, firefox, safari.app",
    );
  });
});
