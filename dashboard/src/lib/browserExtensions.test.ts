import { describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_PROCESSES, normalizeBrowserProcesses } from "./browsers";
import {
  PUBLISHED_TIME_EXTENSION_LISTINGS,
  TIME_EXTENSION_LISTINGS,
  TIME_EXTENSION_NAME,
  listingForProgId,
  storeGateForProgId,
} from "./browserExtensions";

describe("Time browser extension listings", () => {
  // Derived from the setting rather than restated: a browser added to the
  // default list with no listing to serve it is tracked but can never be split
  // by website, and a hardcoded expectation here would pass while that is true.
  it("covers every default supported browser with first-party packages", () => {
    const processes = new Set(
      TIME_EXTENSION_LISTINGS.flatMap((listing) => listing.processes),
    );
    expect(processes).toEqual(
      new Set(normalizeBrowserProcesses(DEFAULT_BROWSER_PROCESSES)),
    );
    expect(TIME_EXTENSION_NAME).toBe("Time Web Extension");
  });

  it("never exposes an unpublished placeholder as a clickable listing", () => {
    expect(PUBLISHED_TIME_EXTENSION_LISTINGS).toEqual(
      TIME_EXTENSION_LISTINGS.filter((listing) => listing.storeUrl !== null),
    );
    expect(
      PUBLISHED_TIME_EXTENSION_LISTINGS.every((listing) =>
        /^https:\/\//.test(listing.storeUrl),
      ),
    ).toBe(true);
  });
});

describe("listingForProgId", () => {
  it("routes every Chromium ProgId to the Chrome Web Store", () => {
    for (const progId of [
      "ChromeHTML",
      "MSEdgeHTM",
      "BraveHTML",
      "OperaStable",
      "VivaldiHTM",
      "ChromiumHTM",
    ]) {
      expect(listingForProgId(progId)?.store).toBe("Chrome Web Store");
    }
  });

  it("matches the per-install suffix Firefox appends to its ProgId", () => {
    expect(listingForProgId("FirefoxURL")?.store).toBe("Firefox Add-ons");
    expect(listingForProgId("FirefoxURL-308046B0AF4A39CB")?.store).toBe(
      "Firefox Add-ons",
    );
  });

  it("ignores ProgId casing, which the registry does not guarantee", () => {
    expect(listingForProgId("chromehtml")?.store).toBe("Chrome Web Store");
  });

  it("sends a Firefox reader to the AMO listing, not to Chrome's package", () => {
    // The failure this guards is silent: a Firefox reader handed the Chrome
    // package sees a store page that cannot install anything for their browser.
    expect(listingForProgId("FirefoxURL")?.storeUrl).toMatch(
      /^https:\/\/addons\.mozilla\.org\//,
    );
  });

  it("returns null when the ProgId is absent or unrecognized", () => {
    expect(listingForProgId(null)).toBeNull();
    expect(listingForProgId(undefined)).toBeNull();
    expect(listingForProgId("")).toBeNull();
    expect(listingForProgId("SomeOtherBrowserURL")).toBeNull();
  });
});

describe("storeGateForProgId", () => {
  it("warns Edge readers about the other-stores prompt", () => {
    expect(storeGateForProgId("MSEdgeHTM")).toContain("other stores");
  });

  it("warns Opera readers that its own add-on comes first", () => {
    expect(storeGateForProgId("OperaStable")).toContain("Install Chrome Extensions");
  });

  // The point of the gate being per-browser: a Chrome reader is never shown a
  // caveat about a browser they are not installing into.
  it("stays silent for browsers that install from the store directly", () => {
    for (const progId of ["ChromeHTML", "BraveHTML", "VivaldiHTM", "FirefoxURL"]) {
      expect(storeGateForProgId(progId)).toBeNull();
    }
  });

  it("has no gate to report for an absent or unrecognized ProgId", () => {
    expect(storeGateForProgId(null)).toBeNull();
    expect(storeGateForProgId("SomeOtherBrowserURL")).toBeNull();
  });
});
