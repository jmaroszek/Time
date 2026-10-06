import { describe, expect, it } from "vitest";

import { allocateMinutes } from "./format";

describe("allocateMinutes", () => {
  it("sums to the rounded total instead of truncating every line", () => {
    const { minutes, total } = allocateMinutes([350, 290, 170, 90]);
    expect(total).toBe(15);
    expect(minutes.reduce((a, b) => a + b, 0)).toBe(15);
  });

  it("gives leftover minutes to the largest remainders, earlier line first on a tie", () => {
    expect(allocateMinutes([90, 90, 90, 90]).minutes).toEqual([2, 2, 1, 1]);
  });

  it("leaves exact minutes alone", () => {
    expect(allocateMinutes([300, 240, 120])).toEqual({ minutes: [5, 4, 2], total: 11 });
  });

  it("handles an empty list", () => {
    expect(allocateMinutes([])).toEqual({ minutes: [], total: 0 });
  });
});
