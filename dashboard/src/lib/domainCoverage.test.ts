import { describe, expect, it } from "vitest";

import {
  browserDomainCoverage,
  shouldShowDomainCoverageHint,
  shouldShowWebsiteRuleHint,
  websiteSignalConfirmed,
} from "./domainCoverage";
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
    const coverage = browserDomainCoverage(
      [session(1_820, null), session(180, "example.com")],
      browsers,
    );
    expect(coverage.missingFraction).toBeGreaterThan(0.9);
    expect(shouldShowDomainCoverageHint(coverage)).toBe(true);
  });

  it("stays hidden at 90% or below", () => {
    const coverage = browserDomainCoverage(
      [session(1_800, null), session(200, "example.com")],
      browsers,
    );
    expect(shouldShowDomainCoverageHint(coverage)).toBe(false);
  });

  it("ignores AFK and non-browser time", () => {
    const firefox = { ...session(3_600, null), process: "firefox.exe" };
    const coverage = browserDomainCoverage(
      [session(1_900, null), session(3_600, null, true), firefox],
      browsers,
    );
    expect(coverage).toEqual({
      totalSeconds: 1_900,
      missingSeconds: 1_900,
      missingFraction: 1,
    });
    expect(shouldShowDomainCoverageHint(coverage)).toBe(true);
  });

  it("says nothing during the half hour after the reader chose about the extension", () => {
    // The hint used to need one minute, so a reader who declined the extension
    // was told about it again almost immediately -- which reads as the answer
    // not having registered. Silence here is the point, not a gap: nothing is
    // known yet that the reader did not just decide.
    const coverage = browserDomainCoverage([session(1_500, null)], browsers);
    expect(coverage.missingFraction).toBe(1);
    expect(shouldShowDomainCoverageHint(coverage)).toBe(false);
    expect(websiteSignalConfirmed(coverage)).toBe(false);
  });
});

describe("shouldShowWebsiteRuleHint", () => {
  const covered = { totalSeconds: 600, missingSeconds: 60, missingFraction: 0.1 };

  it("prompts a reader who classified a browser and never wrote a website rule", () => {
    expect(shouldShowWebsiteRuleHint(covered, true, false)).toBe(true);
  });

  it("stays quiet until a browser has actually been classified", () => {
    expect(shouldShowWebsiteRuleHint(covered, false, false)).toBe(false);
  });

  it("retires once a single website rule exists", () => {
    // One rule proves the reader found the idea. Asking instead whether any
    // website is still unclassified could never fire: classifying the browser
    // is what makes those websites inherit a category in the first place, so
    // the condition would erase itself exactly when it came true.
    expect(shouldShowWebsiteRuleHint(covered, true, true)).toBe(false);
  });

  it("defers to the extension hint when websites are not being recorded", () => {
    // Advice to classify websites is unusable without any website to classify;
    // that reader needs the extension, and both hints at once would compete.
    const uncovered = { totalSeconds: 3_600, missingSeconds: 3_570, missingFraction: 3_570 / 3_600 };
    expect(shouldShowDomainCoverageHint(uncovered)).toBe(true);
    expect(shouldShowWebsiteRuleHint(uncovered, true, false)).toBe(false);
  });

  it("stays quiet while no websites are recorded and the hint has not earned its threshold", () => {
    // The window the diverging thresholds opened. Gating this on the positive
    // signal rather than on "the extension hint is not showing" is what keeps it
    // from advising a rule for sites Time cannot see.
    const early = { totalSeconds: 600, missingSeconds: 600, missingFraction: 1 };
    expect(shouldShowDomainCoverageHint(early)).toBe(false);
    expect(shouldShowWebsiteRuleHint(early, true, false)).toBe(false);
  });

  it("ignores a browser that has barely been used", () => {
    const brief = { totalSeconds: 30, missingSeconds: 0, missingFraction: 0 };
    expect(shouldShowWebsiteRuleHint(brief, true, false)).toBe(false);
  });
});

describe("websiteSignalConfirmed", () => {
  it("confirms once browser time is arriving with sites attached", () => {
    expect(websiteSignalConfirmed({ totalSeconds: 600, missingSeconds: 60, missingFraction: 0.1 }))
      .toBe(true);
  });

  it("waits for enough browser time to mean anything", () => {
    expect(websiteSignalConfirmed({ totalSeconds: 30, missingSeconds: 0, missingFraction: 0 }))
      .toBe(false);
  });

  it("never agrees with the extension hint", () => {
    // The two describe one measurement from opposite sides. If they could ever
    // both be true, a reader would be told website tracking works and that it is
    // not working, in the same slot. They are no longer literal complements --
    // the thresholds differ, so both are false during the grace window -- but
    // both true has to stay impossible.
    for (const coverage of [
      { totalSeconds: 0, missingSeconds: 0, missingFraction: 0 },
      { totalSeconds: 30, missingSeconds: 30, missingFraction: 1 },
      { totalSeconds: 600, missingSeconds: 600, missingFraction: 1 },
      { totalSeconds: 600, missingSeconds: 60, missingFraction: 0.1 },
      { totalSeconds: 3_600, missingSeconds: 3_570, missingFraction: 3_570 / 3_600 },
      { totalSeconds: 6_000, missingSeconds: 5_400, missingFraction: 0.9 },
      { totalSeconds: 6_000, missingSeconds: 5_999, missingFraction: 5_999 / 6_000 },
    ]) {
      expect(websiteSignalConfirmed(coverage) && shouldShowDomainCoverageHint(coverage))
        .toBe(false);
    }
  });
});
