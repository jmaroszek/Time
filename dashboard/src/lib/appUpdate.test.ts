import { describe, expect, it } from "vitest";

import {
  downloadPercent,
  shouldCheckForUpdates,
  updateButtonLabel,
  updateChecksEnabled,
  UPDATE_CHECK_INTERVAL_MS,
} from "./appUpdate";

const onboarded = { privacy_onboarding_complete: "1" };
const NOW = 1_800_000_000_000;

describe("whether to check at all", () => {
  it("treats an absent setting as enabled", () => {
    // The row is backfilled by the tracker, so a dashboard that reads the
    // database first sees nothing here — and must not read that as an opt-out.
    expect(updateChecksEnabled({})).toBe(true);
    expect(shouldCheckForUpdates(onboarded, null, NOW)).toBe(true);
  });

  it("respects an explicit opt-out", () => {
    expect(updateChecksEnabled({ check_updates_automatically: "0" })).toBe(false);
    expect(
      shouldCheckForUpdates(
        { ...onboarded, check_updates_automatically: "0" },
        null,
        NOW,
      ),
    ).toBe(false);
  });

  it("waits for the privacy screen", () => {
    // Time's first network request must not precede the sentence that says it
    // makes one.
    expect(shouldCheckForUpdates({ privacy_onboarding_complete: "0" }, null, NOW)).toBe(false);
    expect(shouldCheckForUpdates({}, null, NOW)).toBe(false);
  });
});

describe("the once-a-day debounce", () => {
  it("asks again only after the interval", () => {
    expect(shouldCheckForUpdates(onboarded, NOW - 1_000, NOW)).toBe(false);
    expect(shouldCheckForUpdates(onboarded, NOW - UPDATE_CHECK_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(shouldCheckForUpdates(onboarded, NOW - UPDATE_CHECK_INTERVAL_MS, NOW)).toBe(true);
  });

  it("recovers from a clock that moved backwards", () => {
    // An NTP correction or a laptop waking in another timezone would otherwise
    // park the next check a full day in the future.
    expect(shouldCheckForUpdates(onboarded, NOW + 86_400_000, NOW)).toBe(true);
  });
});

describe("what the control says", () => {
  const update = { version: "0.2.0", notes: null };

  it("names the version while idle", () => {
    expect(updateButtonLabel(update, false, null)).toBe("Update to 0.2.0");
  });

  it("stays indeterminate until a total arrives", () => {
    expect(downloadPercent(null)).toBeNull();
    expect(downloadPercent({ downloaded: 12, total: null })).toBeNull();
    expect(downloadPercent({ downloaded: 12, total: 0 })).toBeNull();
    expect(updateButtonLabel(update, true, { downloaded: 12, total: null })).toBe(
      "Downloading update…",
    );
  });

  it("reports whole percent once it can", () => {
    expect(downloadPercent({ downloaded: 50, total: 200 })).toBe(25);
    expect(updateButtonLabel(update, true, { downloaded: 50, total: 200 })).toBe(
      "Downloading update… 25%",
    );
  });

  it("never exceeds 100 percent", () => {
    // The chunk callback sums what arrived; a redirect or a retry can push that
    // past a stale content-length.
    expect(downloadPercent({ downloaded: 300, total: 200 })).toBe(100);
  });
});
