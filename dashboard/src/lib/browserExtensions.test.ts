import { describe, expect, it } from "vitest";

import {
  PUBLISHED_TIME_EXTENSION_LISTINGS,
  TIME_EXTENSION_LISTINGS,
  TIME_EXTENSION_NAME,
} from "./browserExtensions";

describe("Time browser extension listings", () => {
  it("covers every default supported browser with first-party packages", () => {
    const processes = new Set(
      TIME_EXTENSION_LISTINGS.flatMap((listing) => listing.processes),
    );
    expect(processes).toEqual(
      new Set([
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "opera.exe",
        "brave.exe",
      ]),
    );
    expect(TIME_EXTENSION_NAME).toBe("Time Website Integration");
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
