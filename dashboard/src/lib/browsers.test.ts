import { describe, expect, it } from "vitest";

import { normalizeBrowserProcesses } from "./browsers";

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
});
