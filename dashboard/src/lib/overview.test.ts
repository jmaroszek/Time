import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";
import {
  bucketActivityHours,
  dailyActivitySummaries,
  hourlyActivitySummaries,
  isCompleteHoursBucket,
  metricSeconds,
  monthlyActivitySummaries,
  overviewGranularity,
  overviewHistoryStart,
  weekdayRhythmSummaries,
  ACTIVITY_METRICS,
  ACTIVITY_METRIC_LABELS,
  ACTIVITY_METRIC_WORDS,
} from "./overview";
import { ACTIVITY_METRIC_RAMPS, CHROME } from "./chartTheme";
import { addDays, dayKey, type Range } from "./time";
import type { Session } from "./metrics";
import { calendarGrid, formatActivityCalendarTooltip } from "../components/ActivityCalendar";
import { formatMonthCalendarTooltip } from "../components/MonthCalendarChart";
import { formatRhythmTooltip } from "../components/RhythmChart";
import {
  categorySeries,
  formatHoursTooltipValue,
  formatHoursBucketRange,
  shouldShowUncategorized,
  visibleAverageHours,
} from "../components/ProductiveHoursChart";

const CATEGORIES: Category[] = [
  { id: 1, name: "Dev", color: "#378ADD", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Games", color: "#D85A30", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Ignored", color: "#777777", isProductive: false, isNeutral: true, isIgnored: true, sortOrder: 3 },
  { id: 4, name: "Neutral", color: "#888888", isProductive: false, isNeutral: true, isIgnored: false, sortOrder: 4 },
];
const RULES: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 100 },
  { id: 2, matchType: "process", pattern: "game.exe", categoryId: 2, priority: 100 },
  { id: 3, matchType: "process", pattern: "secret.exe", categoryId: 3, priority: 100 },
  { id: 4, matchType: "process", pattern: "chat.exe", categoryId: 4, priority: 100 },
];
const classify = buildClassifier(CATEGORIES, RULES, new Set());
let nextId = 1;

function session(start: number, end: number, process: string, isAfk = false): Session {
  return { id: nextId++, start, end, process, title: "", domain: null, isAfk };
}

function rangeFrom(start: Date, days: number): Range {
  return { start, end: addDays(start, days) };
}

describe("overviewGranularity", () => {
  const start = new Date(2026, 0, 1);
  it.each([
    [30, "daily"],
    [31, "weekly"],
    [90, "weekly"],
    [91, "monthly"],
    [730, "monthly"],
    [731, "yearly"],
  ] as const)("uses %i days as %s", (days, expected) => {
    expect(overviewGranularity(rangeFrom(start, days))).toBe(expected);
  });
});

describe("chart visibility thresholds", () => {
  it("requires one total hour before showing Uncategorized", () => {
    expect(shouldShowUncategorized([0.2, 0.3, 0.49])).toBe(false);
    expect(shouldShowUncategorized([0.2, 0.3, 0.5])).toBe(true);
  });
});

describe("dailyActivitySummaries", () => {
  it("zero-fills days, splits midnight, excludes AFK and ignored, and finds the top app", () => {
    const start = new Date(2026, 5, 8);
    const t0 = start.getTime() / 1000;
    const summaries = dailyActivitySummaries(
      [
        session(t0 + 23 * 3600, t0 + 25 * 3600, "code.exe"),
        session(t0 + 25 * 3600, t0 + 27 * 3600, "game.exe"),
        session(t0 + 27 * 3600, t0 + 27.5 * 3600, "chat.exe"),
        session(t0 + 27.5 * 3600, t0 + 27.75 * 3600, "unknown.exe"),
        session(t0 + 26 * 3600, t0 + 28 * 3600, "secret.exe"),
        session(t0 + 28 * 3600, t0 + 29 * 3600, "idle", true),
      ],
      rangeFrom(start, 3),
      classify,
    );

    expect(summaries.map((day) => day.trackedSeconds)).toEqual([3600, 13_500, 0]);
    expect(summaries.map((day) => day.productiveSeconds)).toEqual([3600, 3600, 0]);
    expect(summaries.map((day) => day.neutralSeconds)).toEqual([0, 1800, 0]);
    expect(summaries.map((day) => day.unproductiveSeconds)).toEqual([0, 7200, 0]);
    expect(summaries.map((day) => day.uncategorizedSeconds)).toEqual([0, 900, 0]);
    expect(summaries[1].topApp).toEqual({ process: "game.exe", seconds: 7200 });
    expect(summaries[2].topApp).toBeNull();
    // Category decomposition sums to the same tracked total, unmatched sessions
    // under the Uncategorized label.
    expect(Object.fromEntries(summaries[1].categorySeconds)).toEqual({
      Dev: 3600,
      Games: 7200,
      Neutral: 1800,
      Uncategorized: 900,
    });
  });

  it("formats the tracked calendar tooltip with an aliased top app", () => {
    const day = dailyActivitySummaries(
      [
        session(new Date(2026, 5, 8, 9).getTime() / 1000, new Date(2026, 5, 8, 10).getTime() / 1000, "code.exe"),
        session(new Date(2026, 5, 8, 10).getTime() / 1000, new Date(2026, 5, 8, 10, 30).getTime() / 1000, "game.exe"),
      ],
      rangeFrom(new Date(2026, 5, 8), 1),
      classify,
    )[0];
    const tooltip = formatActivityCalendarTooltip(day, "tracked", { "code.exe": "Editor <Main>" });
    expect(tooltip).toContain("Monday, June 8, 2026");
    expect(tooltip).toContain("Tracked: 1h 30m");
    expect(tooltip).toContain("Top app: Editor &lt;Main&gt; · 1h 0m");
    // The dropdown picks the state; the tracked view need not list the others.
    expect(tooltip).not.toContain("Productive");
    expect(tooltip).not.toContain("Unproductive");
  });

  it("leads the calendar tooltip with the selected metric and its share of tracked", () => {
    const day = dailyActivitySummaries(
      [
        session(new Date(2026, 5, 8, 9).getTime() / 1000, new Date(2026, 5, 8, 10).getTime() / 1000, "code.exe"),
        session(new Date(2026, 5, 8, 10).getTime() / 1000, new Date(2026, 5, 8, 10, 30).getTime() / 1000, "game.exe"),
      ],
      rangeFrom(new Date(2026, 5, 8), 1),
      classify,
    )[0];
    const tooltip = formatActivityCalendarTooltip(day, "productive");
    expect(tooltip).toContain("Productive: 1h 0m");
    expect(tooltip).toContain("67% of tracked time");
    expect(tooltip).toContain("Longest focus: 1h 0m");
    expect(tooltip).not.toContain("Tracked: 1h 30m");
    expect(tooltip).not.toContain("Top app:");
  });
});

describe("monthlyActivitySummaries", () => {
  // Nov 2025 – Feb 2026: four calendar months, one straddling the year boundary.
  const range = { start: new Date(2025, 10, 1), end: new Date(2026, 1, 1) };
  const at = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour).getTime() / 1000;
  const summaries = monthlyActivitySummaries(
    [
      session(at(2025, 10, 3, 9), at(2025, 10, 3, 11), "code.exe"), // Nov: 2h prod
      session(at(2025, 11, 5, 20), at(2025, 11, 5, 22), "game.exe"), // Dec: 2h unprod
      session(at(2025, 11, 31, 23), at(2026, 0, 1, 1), "chat.exe"), // Dec→Jan spans midnight+year
      session(at(2025, 11, 10, 9), at(2025, 11, 10, 10), "secret.exe"), // ignored
      session(at(2025, 11, 12, 9), at(2025, 11, 12, 10), "idle", true), // AFK
    ],
    range,
    classify,
  );
  const month = (key: string) => summaries.find((m) => m.key === key)!;

  it("zero-fills every month in range with year and month indices", () => {
    expect(summaries.map((m) => m.key)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(month("2026-01")).toMatchObject({ year: 2026, month: 0, trackedSeconds: 3600 });
  });

  it("splits a session across the month and year boundary", () => {
    // 11pm Dec 31 → 1am Jan 1: one hour to each side.
    expect(month("2025-12").neutralSeconds).toBe(3600); // chat.exe is Neutral
    expect(month("2026-01").neutralSeconds).toBe(3600);
  });

  it("accumulates state totals, categories, and top app, excluding AFK and ignored", () => {
    expect(month("2025-11")).toMatchObject({
      trackedSeconds: 7200,
      productiveSeconds: 7200,
      topApp: { process: "code.exe", seconds: 7200 },
    });
    expect(Object.fromEntries(month("2025-12").categorySeconds)).toEqual({
      Games: 7200,
      Neutral: 3600,
    });
  });

  it("formats the month tooltip with a share and aliased top app", () => {
    const tooltip = formatMonthCalendarTooltip(month("2025-11"), "tracked", { "code.exe": "Editor" });
    expect(tooltip).toContain("November 2025");
    expect(tooltip).toContain("Tracked: 2h 0m");
    expect(tooltip).toContain("Top app: Editor · 2h 0m");

    const productive = formatMonthCalendarTooltip(month("2025-11"), "productive");
    expect(productive).toContain("Productive: 2h 0m");
    expect(productive).toContain("100% of tracked time");
    expect(productive).toContain("Longest focus: 2h 0m");
    expect(productive).not.toContain("Top app:");
  });
});

describe("hourlyActivitySummaries", () => {
  it("splits sessions across hours and excludes AFK, ignored, and hours outside the day window", () => {
    const start = new Date(2026, 5, 8);
    const at = (hour: number, minute = 0) => new Date(2026, 5, 8, hour, minute).getTime() / 1000;
    const summaries = hourlyActivitySummaries(
      [
        session(at(8, 30), at(9, 30), "code.exe"),
        session(at(9, 30), at(10, 30), "code.exe"),
        session(at(10, 45), at(11, 15), "chat.exe"),
        session(at(11, 15), at(11, 30), "game.exe"),
        session(at(11, 30), at(12), "unknown.exe"),
        session(at(10), at(11), "secret.exe"),
        session(at(9), at(10), "idle", true),
      ],
      rangeFrom(start, 1),
      classify,
      9,
      12,
    );

    expect(summaries.map((hour) => hour.hour)).toEqual([9, 10, 11]);
    expect(summaries.map((hour) => hour.productiveSeconds)).toEqual([3600, 1800, 0]);
    expect(summaries.map((hour) => hour.neutralSeconds)).toEqual([0, 900, 900]);
    expect(summaries.map((hour) => hour.unproductiveSeconds)).toEqual([0, 0, 900]);
    expect(summaries.map((hour) => hour.uncategorizedSeconds)).toEqual([0, 0, 1800]);
  });
});

describe("activity metrics", () => {
  it("orders the selector like the Apps productivity classification", () => {
    expect(ACTIVITY_METRICS).toEqual(["tracked", "productive", "neutral", "unproductive"]);
  });

  it("gives every metric a ramp, a label, and a word", () => {
    for (const metric of ACTIVITY_METRICS) {
      expect(ACTIVITY_METRIC_RAMPS[metric]).toHaveLength(4);
      expect(ACTIVITY_METRIC_LABELS[metric]).toBeTruthy();
      expect(ACTIVITY_METRIC_WORDS[metric]).toBeTruthy();
    }
  });

  it("keeps the neutral ramp below the axis-label gray so cells never read as chrome", () => {
    const neutralRamp = ACTIVITY_METRIC_RAMPS.neutral;
    const brightest = neutralRamp[neutralRamp.length - 1];
    const luminance = (hex: string) =>
      [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0) / 3;
    expect(luminance(brightest)).toBeLessThan(luminance(CHROME.axisLabel));
  });

  it("starts every ramp at the same empty-cell fill", () => {
    const zeros = new Set(ACTIVITY_METRICS.map((m) => ACTIVITY_METRIC_RAMPS[m][0]));
    expect(zeros.size).toBe(1);
  });
});

describe("calendarGrid", () => {
  // Sun Jun 21 2026 is a week start, so these counts are exact.
  const from = (days: number) => calendarGrid(rangeFrom(new Date(2026, 5, 21), days), "Sunday");

  it("counts week columns from the aligned week containing the range start", () => {
    expect(from(30).weekColumns).toBe(5);
    expect(from(90).weekColumns).toBe(13);
    expect(from(365).weekColumns).toBe(53);
    // A range starting mid-week still owns the whole column it falls in.
    expect(calendarGrid(rangeFrom(new Date(2026, 5, 24), 7), "Sunday").weekColumns).toBe(2);
  });

  it("sizes short ranges squarely instead of letting cells stretch", () => {
    expect(from(30).cellPx).toBe(40);
    expect(from(90).cellPx).toBe(40);
  });

  it("puts weekdays across the top only for short calendars", () => {
    expect(from(30).orientation).toBe("vertical");
    expect(from(8 * 7).orientation).toBe("vertical");
    expect(from(8 * 7 + 1).orientation).toBe("horizontal");
    expect(from(90).orientation).toBe("horizontal");
  });

  it("hands long ranges back to auto sizing", () => {
    expect(from(365).cellPx).toBeNull();
  });

  it("shrinks cells rather than overflowing as columns approach the threshold", () => {
    const wide = calendarGrid(rangeFrom(new Date(2026, 5, 21), 30 * 7), "Sunday");
    expect(wide.weekColumns).toBe(30);
    expect(wide.cellPx).toBe(29);
    expect(wide.cellPx! * wide.weekColumns).toBeLessThanOrEqual(880);
  });

  it("counts whole weeks across a DST boundary", () => {
    // Jun 21 2026 -> Jan 17 2027 is exactly 30 weeks, but spans a fall-back
    // hour; measuring in raw ms rounds that up to a phantom 31st column.
    expect(from(30 * 7).weekColumns).toBe(30);
  });
});

describe("categorySeries", () => {
  const buckets = [
    // Uncategorized clears the one-hour floor below, so it earns a series.
    { categorySeconds: new Map([["Dev", 7200], ["Games", 3600], ["Uncategorized", 3600]]) },
    { categorySeconds: new Map([["Dev", 3600], ["Neutral", 900]]) },
  ];

  it("orders largest total first, using configured order to break ties", () => {
    const series = categorySeries(buckets, CATEGORIES);
    expect(series.map((s) => s.name)).toEqual(["Dev", "Games", "Uncategorized", "Neutral"]);
    expect(series.find((s) => s.name === "Dev")!.hours).toEqual([2, 1]);
    expect(series.find((s) => s.name === "Uncategorized")!.hours).toEqual([1, 0]);
  });

  it("holds Uncategorized back until it reaches an hour, unlike real categories", () => {
    const thin = [{ categorySeconds: new Map([["Dev", 60], ["Uncategorized", 1800]]) }];
    const series = categorySeries(thin, CATEGORIES);
    // Dev shows with a single minute; sub-hour Uncategorized is suppressed.
    expect(series.map((s) => s.name)).toEqual(["Dev"]);
  });

  it("puts a later configured category at the bottom when it has more total time", () => {
    const series = categorySeries(
      [{ categorySeconds: new Map([["Dev", 3600], ["Neutral", 7200]]) }],
      CATEGORIES,
    );
    expect(series.map((s) => s.name)).toEqual(["Neutral", "Dev"]);
  });

  it("keeps each category's configured color and Uncategorized gray", () => {
    const series = categorySeries(buckets, CATEGORIES);
    expect(series.find((s) => s.name === "Dev")!.color).toBe("#378ADD");
    expect(series.find((s) => s.name === "Uncategorized")!.color).toBe("#5b616b");
  });

  it("omits ignored categories and any category with no time in range", () => {
    const series = categorySeries(buckets, CATEGORIES);
    // "Ignored" is isIgnored; sessions never accrue to it upstream anyway.
    expect(series.some((s) => s.name === "Ignored")).toBe(false);
    // No bucket carries Games in the second slot, but it still appears because
    // the first does; a category absent from every bucket is dropped entirely.
    const noGames = categorySeries(
      [{ categorySeconds: new Map([["Dev", 3600]]) }],
      CATEGORIES,
    );
    expect(noGames.map((s) => s.name)).toEqual(["Dev"]);
  });
});

describe("formatHoursTooltipValue", () => {
  it("formats finite durations and omits missing rolling-average values", () => {
    expect(formatHoursTooltipValue(1.25)).toBe("1.3h");
    expect(formatHoursTooltipValue("-")).toBeNull();
    expect(formatHoursTooltipValue(null)).toBeNull();
    expect(formatHoursTooltipValue(Number.NaN)).toBeNull();
  });
});

describe("visibleAverageHours", () => {
  it("hides zero rolling averages and preserves positive values", () => {
    expect(visibleAverageHours(0)).toBeNull();
    expect(visibleAverageHours(0.004)).toBeNull();
    expect(visibleAverageHours(null)).toBeNull();
    expect(visibleAverageHours(1.236)).toBe(1.24);
  });
});

describe("weekdayRhythmSummaries", () => {
  // Mon Jun 8 – Mon Jun 22, 2026 (15 days): three Mondays, two of everything else.
  const range = rangeFrom(new Date(2026, 5, 8), 15);
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 5, day, hour, minute).getTime() / 1000;
  const summary = () =>
    weekdayRhythmSummaries(
      [
        session(at(8, 9), at(8, 10, 30), "code.exe"),
        session(at(15, 9, 15), at(15, 9, 45), "game.exe"),
        session(at(10, 11), at(10, 11, 15), "unknown.exe"),
        session(at(9, 8), at(9, 9), "code.exe"), // before the visible window
        session(at(8, 11), at(8, 11, 30), "secret.exe"), // ignored
        session(at(8, 9), at(8, 9, 30), "idle", true), // AFK
      ],
      range,
      classify,
      9,
      12,
    );

  const cell = (weekday: number, hour: number) =>
    summary().cells.find((c) => c.weekday === weekday && c.hour === hour)!;

  it("counts weekday occurrences from calendar days in the range", () => {
    expect(summary().weekdayCounts).toEqual([2, 3, 2, 2, 2, 2, 2]);
  });

  it("zero-fills every visible weekday-hour cell", () => {
    expect(summary().cells).toHaveLength(7 * 3);
    expect(cell(0, 9)).toMatchObject({ trackedSeconds: 0, topApp: null });
  });

  it("totals sessions into (weekday, hour) cells, excluding AFK, ignored, and out-of-window hours", () => {
    expect(cell(1, 9)).toMatchObject({
      trackedSeconds: 5400,
      productiveSeconds: 3600,
      unproductiveSeconds: 1800,
      topApp: { process: "code.exe", seconds: 3600 },
    });
    expect(cell(1, 10)).toMatchObject({ trackedSeconds: 1800, productiveSeconds: 1800 });
    expect(cell(1, 11).trackedSeconds).toBe(0); // ignored session invisible
    expect(cell(2, 9).trackedSeconds).toBe(0); // 8am session stays out of the window
    expect(cell(3, 11)).toMatchObject({ trackedSeconds: 900, uncategorizedSeconds: 900 });
  });

  it("formats the tracked tooltip as a per-occurrence average with an aliased top app", () => {
    const tooltip = formatRhythmTooltip(cell(1, 9), 3, "tracked", { "code.exe": "Editor <Main>" });
    expect(tooltip).toContain("Monday · 9am–10am");
    expect(tooltip).toContain("Avg tracked: 30m");
    expect(tooltip).toContain("Top app: Editor &lt;Main&gt; · 1h 0m total");
    // The dropdown selects the state, so the tooltip lists only the shaded one:
    // no occurrence count, no other-state breakdown.
    expect(tooltip).not.toContain("Mondays");
    expect(tooltip).not.toContain("Productive");
    expect(tooltip).not.toContain("Unproductive");
  });

  it("leads a subset metric with its value and share of tracked", () => {
    const tooltip = formatRhythmTooltip(cell(1, 9), 3, "productive");
    expect(tooltip).toContain("Avg productive: 20m");
    expect(tooltip).toContain("67% of tracked time");
    expect(tooltip).not.toContain("Tracked: 30m");
    expect(tooltip).not.toContain("Top app:");
    // No occurrence count, and the other subset states stay out.
    expect(tooltip).not.toContain("Mondays");
    expect(tooltip).not.toContain("Unproductive");
    expect(tooltip).not.toContain("Neutral");
  });

  it("shares are relative to tracked for unproductive and neutral too", () => {
    const unproductive = formatRhythmTooltip(cell(1, 9), 3, "unproductive");
    expect(unproductive).toContain("Avg unproductive: 10m");
    expect(unproductive).toContain("33% of tracked time");
    expect(unproductive).not.toContain("Tracked: 30m");

    const neutral = formatRhythmTooltip(cell(1, 9), 3, "neutral");
    expect(neutral).toContain("Avg neutral: 0s");
    expect(neutral).toContain("0% of tracked time");
    expect(neutral).not.toContain("Tracked: 30m");
  });

  it("reads every metric off the same totals", () => {
    const totals = cell(1, 9);
    expect(metricSeconds(totals, "tracked")).toBe(5400);
    expect(metricSeconds(totals, "productive")).toBe(3600);
    expect(metricSeconds(totals, "unproductive")).toBe(1800);
    expect(metricSeconds(totals, "neutral")).toBe(0);
  });
});

describe("bucketActivityHours", () => {
  function syntheticDays(range: Range) {
    return dailyActivitySummaries([], range, classify).map((day, index) => ({
      ...day,
      productiveSeconds: (index + 1) * 100,
      neutralSeconds: (index + 1) * 5,
      unproductiveSeconds: (index + 1) * 3,
      uncategorizedSeconds: (index + 1) * 2,
      trackedSeconds: (index + 1) * 110,
    }));
  }

  it("aligns partial weeks to Sunday", () => {
    const range = rangeFrom(new Date(2026, 5, 10), 10); // Wed Jun 10 – Fri Jun 19
    const buckets = bucketActivityHours(syntheticDays(range), range, "weekly", "Sunday");
    expect(buckets.map((bucket) => dayKey(bucket.periodStart))).toEqual(["2026-06-07", "2026-06-14"]);
    expect(buckets.map((bucket) => dayKey(bucket.includedStart))).toEqual(["2026-06-10", "2026-06-14"]);
    expect(buckets.map((bucket) => dayKey(bucket.includedEnd))).toEqual(["2026-06-14", "2026-06-20"]);
    expect(buckets.map((bucket) => bucket.productiveSeconds)).toEqual([1000, 4500]);
    expect(buckets.map((bucket) => bucket.neutralSeconds)).toEqual([50, 225]);
    expect(isCompleteHoursBucket(buckets[0], "weekly")).toBe(false);
    expect(isCompleteHoursBucket(buckets[1], "weekly")).toBe(false);
  });

  it("aligns partial weeks to Monday", () => {
    const range = rangeFrom(new Date(2026, 5, 10), 10);
    const buckets = bucketActivityHours(syntheticDays(range), range, "weekly", "Monday");
    expect(buckets.map((bucket) => dayKey(bucket.periodStart))).toEqual(["2026-06-08", "2026-06-15"]);
    expect(buckets.map((bucket) => bucket.productiveSeconds)).toEqual([1500, 4000]);
  });

  it("recognizes complete aligned periods", () => {
    const weeklyRange = rangeFrom(new Date(2026, 5, 7), 14);
    const weeks = bucketActivityHours(syntheticDays(weeklyRange), weeklyRange, "weekly", "Sunday");
    expect(weeks.every((bucket) => isCompleteHoursBucket(bucket, "weekly"))).toBe(true);

    const monthlyRange = { start: new Date(2026, 5, 1), end: new Date(2026, 7, 1) };
    const months = bucketActivityHours(syntheticDays(monthlyRange), monthlyRange, "monthly", "Sunday");
    expect(months.every((bucket) => isCompleteHoursBucket(bucket, "monthly"))).toBe(true);
  });

  it("aligns partial months across a year boundary and retains empty buckets", () => {
    const range = rangeFrom(new Date(2026, 11, 30), 4);
    const days = dailyActivitySummaries([], range, classify);
    days[0].productiveSeconds = 3600;
    const buckets = bucketActivityHours(days, range, "monthly", "Sunday");
    expect(buckets.map((bucket) => dayKey(bucket.periodStart))).toEqual(["2026-12-01", "2027-01-01"]);
    expect(buckets.map((bucket) => bucket.productiveSeconds)).toEqual([3600, 0]);
    expect(dayKey(buckets[0].includedStart)).toBe("2026-12-30");
    expect(dayKey(buckets[1].includedEnd)).toBe("2027-01-03");
    expect(formatHoursBucketRange(buckets[0])).toBe("Dec 30, 2026–Dec 31, 2026");
    expect(formatHoursBucketRange(buckets[1])).toBe("Jan 1, 2027–Jan 2, 2027");
  });

  it("buckets by calendar year and aligns partial years", () => {
    // Apr 2024 – Feb 2026: three calendar years, first and last partial.
    const range = { start: new Date(2024, 3, 1), end: new Date(2026, 1, 1) };
    const days = dailyActivitySummaries([], range, classify);
    days[0].productiveSeconds = 3600; // Apr 1 2024
    days[days.length - 1].neutralSeconds = 1800; // Jan 31 2026
    const buckets = bucketActivityHours(days, range, "yearly", "Sunday");
    expect(buckets.map((bucket) => dayKey(bucket.periodStart))).toEqual([
      "2024-01-01", "2025-01-01", "2026-01-01",
    ]);
    expect(buckets.map((bucket) => bucket.productiveSeconds)).toEqual([3600, 0, 0]);
    expect(buckets.map((bucket) => bucket.neutralSeconds)).toEqual([0, 0, 1800]);
    // Only the full middle year is complete; the clipped ends are not.
    expect(buckets.map((bucket) => isCompleteHoursBucket(bucket, "yearly"))).toEqual([
      false, true, false,
    ]);
  });

  it("keeps enough aligned history for each rolling-average scale", () => {
    const range = rangeFrom(new Date(2026, 5, 10), 40);
    expect(dayKey(overviewHistoryStart(range, "daily", "Sunday"))).toBe("2026-06-04");
    expect(dayKey(overviewHistoryStart(range, "weekly", "Sunday"))).toBe("2026-05-17");
    expect(dayKey(overviewHistoryStart(range, "weekly", "Monday"))).toBe("2026-05-18");
    expect(dayKey(overviewHistoryStart(range, "monthly", "Sunday"))).toBe("2026-04-01");
    expect(dayKey(overviewHistoryStart(range, "yearly", "Sunday"))).toBe("2024-01-01");
  });
});
