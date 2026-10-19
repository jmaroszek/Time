import { describe, expect, it } from "vitest";

import {
  downloadPercent,
  shouldCheckForUpdates,
  updateButtonLabel,
  updateChecksEnabled,
} from "./appUpdate";

const onboarded = { privacy_onboarding_complete: "1" };

describe("whether to check at all", () => {
  it("treats an absent setting as enabled", () => {
    // The row is backfilled by the tracker, so a dashboard that reads the
    // database first sees nothing here — and must not read that as an opt-out.
    expect(updateChecksEnabled({})).toBe(true);
    expect(shouldCheckForUpdates(onboarded)).toBe(true);
  });

  it("respects an explicit opt-out", () => {
    expect(updateChecksEnabled({ check_updates_automatically: "0" })).toBe(false);
    expect(shouldCheckForUpdates({ ...onboarded, check_updates_automatically: "0" })).toBe(false);
  });

  it("waits for the privacy screen", () => {
    // Time's first network request must not precede the sentence that says it
    // makes one.
    expect(shouldCheckForUpdates({ privacy_onboarding_complete: "0" })).toBe(false);
    expect(shouldCheckForUpdates({})).toBe(false);
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
