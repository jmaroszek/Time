import { afterEach, describe, expect, it } from "vitest";

import { isLifecycleBusy, withLifecycleBusy } from "./lifecycleBusy";

describe("shared lifecycle busy transport", () => {
  afterEach(() => {
    expect(isLifecycleBusy()).toBe(false);
  });

  it("stays busy until overlapping lifecycle requests all settle", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = withLifecycleBusy(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const second = withLifecycleBusy(
      () => new Promise<void>((resolve) => {
        releaseSecond = resolve;
      }),
    );

    expect(isLifecycleBusy()).toBe(true);
    releaseFirst();
    await first;
    expect(isLifecycleBusy()).toBe(true);
    releaseSecond();
    await second;
    expect(isLifecycleBusy()).toBe(false);
  });

  it("releases the gate when an operation throws synchronously", async () => {
    await expect(
      withLifecycleBusy(() => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    expect(isLifecycleBusy()).toBe(false);
  });
});
