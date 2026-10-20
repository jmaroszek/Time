import { describe, expect, it } from "vitest";

import { allocateMinutes, fmtDuration, fmtDurationTitle, fmtElapsed, fmtExactDuration, fmtWholeHours } from "./format";

const HOUR = 3600;

describe("fmtDuration", () => {
  it("keeps hours and minutes below 100 hours", () => {
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(12 * 60)).toBe("12m");
    expect(fmtDuration(42 * HOUR + 15 * 60)).toBe("42h 15m");
    expect(fmtDuration(100 * HOUR - 1)).toBe("99h 59m");
  });

  it("rounds to whole hours from 100 hours, never reaching for days", () => {
    expect(fmtDuration(100 * HOUR)).toBe("100h");
    expect(fmtDuration(812 * HOUR + 14 * 60)).toBe("812h");
    expect(fmtDuration(812 * HOUR + 31 * 60)).toBe("813h");
  });

  it("groups thousands without following the host locale", () => {
    expect(fmtDuration(1204 * HOUR)).toBe("1,204h");
    expect(fmtDuration(1_234_567 * HOUR)).toBe("1,234,567h");
  });
});

describe("fmtWholeHours", () => {
  it("rounds and groups like the large durations do", () => {
    expect(fmtWholeHours(32.4)).toBe("32h");
    expect(fmtWholeHours(1430.6)).toBe("1,431h");
  });
});

describe("fmtExactDuration and fmtDurationTitle", () => {
  it("keeps the minutes a compact value dropped, for hover text", () => {
    expect(fmtExactDuration(1204 * HOUR + 14 * 60)).toBe("1,204h 14m");
    expect(fmtDurationTitle(1204 * HOUR + 14 * 60)).toBe("1,204h 14m");
  });

  it("gives no hover text when the shown value is already exact", () => {
    expect(fmtDurationTitle(42 * HOUR + 15 * 60)).toBeUndefined();
    expect(fmtDurationTitle(150 * HOUR)).toBe("150h 0m");
  });
});

describe("fmtElapsed", () => {
  it("matches fmtDuration under a day", () => {
    expect(fmtElapsed(90)).toBe("1m");
    expect(fmtElapsed(23 * HOUR + 59 * 60)).toBe("23h 59m");
  });

  it("counts whole days past a day", () => {
    expect(fmtElapsed(24 * HOUR)).toBe("1 day");
    expect(fmtElapsed(52 * HOUR)).toBe("2 days");
    expect(fmtElapsed(1500 * 24 * HOUR)).toBe("1,500 days");
  });

  it("treats a clock-skewed negative age as zero", () => {
    expect(fmtElapsed(-30)).toBe("0s");
  });
});

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
