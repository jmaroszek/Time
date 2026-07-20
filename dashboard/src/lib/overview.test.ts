import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";
import {
  bucketActivityHours,
  dailyActivitySummaries,
  hourlyActivitySummaries,
  isCompleteHoursBucket,
  overviewGranularity,
  overviewHistoryStart,
  weekdayRhythmSummaries,
} from "./overview";
import { addDays, dayKey, type Range } from "./time";
import type { Session } from "./metrics";
import { formatActivityCalendarTooltip } from "../components/ActivityCalendar";
import { formatRhythmTooltip } from "../components/RhythmChart";
import {
  formatHoursBucketRange,
  shouldShowUncategorized,
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
  });

  it("formats complete calendar hover detail with an aliased top app", () => {
    const day = dailyActivitySummaries(
      [
        session(new Date(2026, 5, 8, 9).getTime() / 1000, new Date(2026, 5, 8, 10).getTime() / 1000, "code.exe"),
        session(new Date(2026, 5, 8, 10).getTime() / 1000, new Date(2026, 5, 8, 10, 30).getTime() / 1000, "game.exe"),
      ],
      rangeFrom(new Date(2026, 5, 8), 1),
      classify,
    )[0];
    const tooltip = formatActivityCalendarTooltip(day, { "code.exe": "Editor <Main>" });
    expect(tooltip).toContain("Monday, June 8, 2026");
    expect(tooltip).toContain("Tracked: 1h 30m");
    expect(tooltip).toContain("Productive: 1h 0m (67%)");
    expect(tooltip).toContain("Neutral: 0s");
    expect(tooltip).toContain("Unproductive: 30m");
    expect(tooltip).toContain("Uncategorized: 0s");
    expect(tooltip).toContain("Top app: Editor &lt;Main&gt; · 1h 0m");
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

  it("formats the tooltip with per-occurrence averages and an aliased top app", () => {
    const tooltip = formatRhythmTooltip(cell(1, 9), 3, "tracked", { "code.exe": "Editor <Main>" });
    expect(tooltip).toContain("Monday · 9am–10am");
    expect(tooltip).toContain("Avg tracked: 30m");
    expect(tooltip).toContain("(over 3 Mondays)");
    expect(tooltip).toContain("Productive: 20m");
    expect(tooltip).toContain("Unproductive: 10m");
    expect(tooltip).toContain("Neutral: 0s");
    expect(tooltip).toContain("Top app: Editor &lt;Main&gt; · 1h 0m total");
  });

  it("leads the tooltip with whichever metric the color encodes", () => {
    const tooltip = formatRhythmTooltip(cell(1, 9), 3, "productive");
    expect(tooltip).toContain("Avg productive: 20m");
    expect(tooltip).toContain("(over 3 Mondays)");
    expect(tooltip).toContain("Tracked: 30m");
  });

  it("uses the singular weekday name for a single occurrence", () => {
    expect(formatRhythmTooltip(cell(0, 9), 1)).toContain("(over 1 Sunday)");
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

  it("keeps enough aligned history for each rolling-average scale", () => {
    const range = rangeFrom(new Date(2026, 5, 10), 40);
    expect(dayKey(overviewHistoryStart(range, "daily", "Sunday"))).toBe("2026-06-04");
    expect(dayKey(overviewHistoryStart(range, "weekly", "Sunday"))).toBe("2026-05-17");
    expect(dayKey(overviewHistoryStart(range, "weekly", "Monday"))).toBe("2026-05-18");
    expect(dayKey(overviewHistoryStart(range, "monthly", "Sunday"))).toBe("2026-04-01");
  });
});
