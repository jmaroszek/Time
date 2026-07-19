import { describe, expect, it } from "vitest";

import { browserDomainCoverage, shouldShowDomainCoverageHint } from "./domainCoverage";
import type { Session } from "./metrics";

const browsers = new Set(["chrome.exe"]);

function session(seconds: number, domain: string | null, isAfk = false): Session {
  return {
    id: 1,
    start: 1_000,
    end: 1_000 + seconds,
    process: "chrome.exe",
    title: "Browser",
    domain,
    isAfk,
  };
}

describe("browser domain coverage hint", () => {
  it("appears when more than 90% of meaningful browser time lacks a domain", () => {
    const coverage = browserDomainCoverage([session(91, null), session(9, "example.com")], browsers);
    expect(coverage.missingFraction).toBe(0.91);
    expect(shouldShowDomainCoverageHint(coverage)).toBe(true);
  });

  it("stays hidden at 90% or below", () => {
    const coverage = browserDomainCoverage([session(90, null), session(10, "example.com")], browsers);
    expect(shouldShowDomainCoverageHint(coverage)).toBe(false);
  });

  it("ignores AFK and non-browser time and waits for one minute", () => {
    const firefox = { ...session(600, null), process: "firefox.exe" };
    const coverage = browserDomainCoverage([session(59, null), session(600, null, true), firefox], browsers);
    expect(coverage).toEqual({ totalSeconds: 59, missingSeconds: 59, missingFraction: 1 });
    expect(shouldShowDomainCoverageHint(coverage)).toBe(false);
  });
});
