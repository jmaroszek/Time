import { describe, expect, it } from "vitest";

import { bannerDismissMs } from "./banner";

describe("bannerDismissMs", () => {
  it("clears a confirmation on its own", () => {
    // A confirmation has done its job once read. Leaving it up makes someone
    // dismiss the news of their own success.
    expect(bannerDismissMs("good")).toBeGreaterThan(0);
  });

  it("keeps a failure until it is dismissed", () => {
    // The only record that a write did not happen. It waits to be acknowledged.
    expect(bannerDismissMs("bad")).toBeNull();
  });
});
