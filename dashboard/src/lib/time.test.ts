import { describe, expect, it } from "vitest";

import {
  addDays,
  allTimeRange,
  calendarDays,
  clampCustomRange,
  clampRangeStart,
  dayKey,
  listDays,
  matchedPreviousRange,
  parseDateInput,
  previousRange,
  rangeForCalendarPreset,
  rangeForPreset,
  startOfWeek,
} from "./time";

// Tue Jun 9 2026, 15:30 local
const NOW = new Date(2026, 5, 9, 15, 30);

describe("startOfWeek", () => {
  it("sunday start", () => {
    expect(startOfWeek(NOW, "Sunday")).toEqual(new Date(2026, 5, 7));
  });
  it("monday start", () => {
    expect(startOfWeek(NOW, "Monday")).toEqual(new Date(2026, 5, 8));
  });
  it("on the week-start day itself", () => {
    expect(startOfWeek(new Date(2026, 5, 7, 10), "Sunday")).toEqual(new Date(2026, 5, 7));
  });
});

describe("rangeForPreset (rolling windows ending today)", () => {
  it("today is [midnight, next midnight)", () => {
    const r = rangeForPreset("today", NOW);
    expect(r.start).toEqual(new Date(2026, 5, 9));
    expect(r.end).toEqual(new Date(2026, 5, 10));
  });
  it("last7 includes today and the 6 days before", () => {
    const r = rangeForPreset("last7", NOW);
    expect(r.start).toEqual(new Date(2026, 5, 3));
    expect(r.end).toEqual(new Date(2026, 5, 10));
    expect(calendarDays(r)).toBe(7);
  });
  it("last14 is a 14-day window ending today", () => {
    const r = rangeForPreset("last14", NOW);
    expect(calendarDays(r)).toBe(14);
    expect(r.end).toEqual(new Date(2026, 5, 10));
  });
  it("last30 is a 30-day window ending today", () => {
    const r = rangeForPreset("last30", NOW);
    expect(calendarDays(r)).toBe(30);
    expect(r.start).toEqual(new Date(2026, 4, 11));
  });
  it("last90 is a 90-day rolling window ending today", () => {
    const r = rangeForPreset("last90", NOW);
    expect(calendarDays(r)).toBe(90);
    expect(r.end).toEqual(new Date(2026, 5, 10));
  });
  it("last365 is a 365-day rolling window ending today", () => {
    const r = rangeForPreset("last365", NOW);
    expect(calendarDays(r)).toBe(365);
    expect(r.end).toEqual(new Date(2026, 5, 10));
  });
});

describe("rangeForCalendarPreset (calendar-aligned windows ending today)", () => {
  it("starts a week according to the configured week start", () => {
    expect(rangeForCalendarPreset("last7", "Sunday", NOW)).toEqual({
      start: new Date(2026, 5, 7),
      end: new Date(2026, 5, 10),
    });
    expect(rangeForCalendarPreset("last7", "Monday", NOW)).toEqual({
      start: new Date(2026, 5, 8),
      end: new Date(2026, 5, 10),
    });
  });

  it("starts a month on its first day", () => {
    expect(rangeForCalendarPreset("last30", "Sunday", NOW)).toEqual({
      start: new Date(2026, 5, 1),
      end: new Date(2026, 5, 10),
    });
  });

  it("starts a quarter on its first day", () => {
    expect(rangeForCalendarPreset("last90", "Sunday", NOW)).toEqual({
      start: new Date(2026, 3, 1),
      end: new Date(2026, 5, 10),
    });
  });

  it("starts a year on January 1", () => {
    expect(rangeForCalendarPreset("last365", "Sunday", NOW)).toEqual({
      start: new Date(2026, 0, 1),
      end: new Date(2026, 5, 10),
    });
  });
});

describe("allTimeRange", () => {
  it("spans the earliest session's day through end of today", () => {
    const firstSec = new Date(2022, 2, 15, 9, 30).getTime() / 1000;
    const r = allTimeRange(firstSec, NOW);
    expect(r.start).toEqual(new Date(2022, 2, 15)); // clamped to that day's midnight
    expect(r.end).toEqual(new Date(2026, 5, 10));
  });

  it("collapses to today when there are no sessions", () => {
    const r = allTimeRange(null, NOW);
    expect(r.start).toEqual(new Date(2026, 5, 9));
    expect(r.end).toEqual(new Date(2026, 5, 10));
    expect(calendarDays(r)).toBe(1);
  });
});

describe("clampRangeStart", () => {
  it("pulls the start forward to the first tracked day when the range reaches earlier", () => {
    const r = rangeForPreset("last365", NOW); // starts 2025-06-10
    const firstSec = new Date(2026, 2, 15).getTime() / 1000; // Mar 15 2026
    const clamped = clampRangeStart(r, firstSec);
    expect(clamped.start).toEqual(new Date(2026, 2, 15));
    expect(clamped.end).toEqual(r.end);
  });

  it("leaves the range untouched when data predates it", () => {
    const r = rangeForPreset("last30", NOW);
    const firstSec = new Date(2022, 0, 1).getTime() / 1000;
    expect(clampRangeStart(r, firstSec)).toEqual(r);
  });

  it("leaves the range untouched with no sessions yet", () => {
    const r = rangeForPreset("last365", NOW);
    expect(clampRangeStart(r, null)).toEqual(r);
  });
});

describe("clampCustomRange", () => {
  const firstSec = new Date(2026, 5, 7, 14).getTime() / 1000;

  it("limits custom dates to the first tracked day through today", () => {
    expect(clampCustomRange(
      { start: new Date(2026, 4, 1), end: new Date(2026, 6, 1) },
      firstSec,
      NOW,
    )).toEqual({ start: new Date(2026, 5, 7), end: new Date(2026, 5, 10) });
  });

  it("re-clamps a range whose prior history was deleted", () => {
    expect(clampCustomRange(
      { start: new Date(2026, 4, 1), end: new Date(2026, 4, 3) },
      firstSec,
      NOW,
    )).toEqual({ start: new Date(2026, 5, 7), end: new Date(2026, 5, 8) });
  });
});

describe("calendarDays across DST", () => {
  it("counts calendar days even when a day is 23h or 25h", () => {
    // US spring-forward 2026: Mar 8. Mar 7 -> Mar 10 is 3 calendar days
    // regardless of the missing hour (when the env observes US DST).
    const r = { start: new Date(2026, 2, 7), end: new Date(2026, 2, 10) };
    expect(calendarDays(r)).toBe(3);
  });
});

describe("previousRange", () => {
  it("is the equal-length period immediately before", () => {
    const r = { start: new Date(2026, 5, 7), end: new Date(2026, 5, 10) };
    const prev = previousRange(r);
    expect(prev.start).toEqual(new Date(2026, 5, 4));
    expect(prev.end).toEqual(new Date(2026, 5, 7));
  });
});

describe("matchedPreviousRange", () => {
  it("clips today's comparison to the same local time", () => {
    const current = { start: new Date(2026, 5, 9), end: new Date(2026, 5, 10) };
    expect(matchedPreviousRange(current, NOW)).toEqual({
      start: new Date(2026, 5, 8),
      end: new Date(2026, 5, 8, 15, 30),
    });
  });

  it("matches the partial last day of a longer window", () => {
    const current = { start: new Date(2026, 5, 3), end: new Date(2026, 5, 10) };
    expect(matchedPreviousRange(current, NOW)).toEqual({
      start: new Date(2026, 4, 27),
      end: new Date(2026, 5, 2, 15, 30),
    });
  });
});

describe("listDays / dayKey", () => {
  it("lists local midnights", () => {
    const days = listDays({ start: new Date(2026, 5, 7), end: new Date(2026, 5, 10) });
    expect(days.map(dayKey)).toEqual(["2026-06-07", "2026-06-08", "2026-06-09"]);
  });
});

describe("addDays", () => {
  it("handles month boundaries", () => {
    expect(addDays(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 1));
  });
});

describe("parseDateInput", () => {
  it("parses ISO date input", () => {
    expect(parseDateInput("2026-06-09")).toEqual(new Date(2026, 5, 9));
  });
  it("rejects garbage", () => {
    expect(parseDateInput("junk")).toBeNull();
    expect(parseDateInput("06/09/26")).toBeNull();
  });
});
