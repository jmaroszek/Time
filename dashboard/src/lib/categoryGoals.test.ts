import { describe, expect, it } from "vitest";

import type { Category } from "./classify";
import {
  fmtGoalHours,
  fmtGoalTarget,
  goalBarParts,
  goalCategories,
  goalProgress,
  goalSummary,
  goalTargetLabel,
  roundGoalHours,
} from "./categoryGoals";
import { goalPace } from "./metrics";
import type { Range } from "./time";

const week: Range = { start: new Date(2026, 9, 18), end: new Date(2026, 9, 25) };
const day: Range = { start: new Date(2026, 9, 24), end: new Date(2026, 9, 25) };
const eightWeeks: Range = { start: new Date(2026, 7, 30), end: new Date(2026, 9, 25) };
const hours = (value: number) => value * 3600;

const category = (id: number, extra: Partial<Category> = {}): Category => ({
  id,
  name: `C${id}`,
  color: "#000",
  isProductive: false,
  isNeutral: false,
  isIgnored: false,
  sortOrder: id,
  ...extra,
});

describe("goalProgress", () => {
  it("prorates the weekly goal by the range's length, as the overall goal does", () => {
    const target = { hours: 10, kind: "at_least" as const };
    expect(goalProgress(0, week, target).targetSeconds).toBe(hours(10));
    expect(goalProgress(0, eightWeeks, target).targetSeconds).toBe(hours(80));
    expect(goalProgress(0, day, target).targetSeconds).toBeCloseTo(hours(10 / 7));
    expect(goalProgress(0, day, target).targetSeconds / 3600).toBeCloseTo(goalPace(0, day, 10).targetHours);
  });

  it("counts a target as met only once it is reached", () => {
    const goal = { hours: 10, kind: "at_least" as const };
    const behind = goalProgress(hours(10) - 1, week, goal);
    expect(behind).toMatchObject({ met: false, over: false, onTrack: false });
    const reached = goalProgress(hours(10), week, goal);
    expect(reached).toMatchObject({ met: true, over: false, onTrack: true, fraction: 1 });
  });

  it("never counts a limit as met, and calls it over only past the limit", () => {
    const goal = { hours: 5, kind: "at_most" as const };
    expect(goalProgress(hours(5), week, goal)).toMatchObject({ met: false, over: false, onTrack: true });
    // Exact, not rounded: twenty seconds over is over.
    expect(goalProgress(hours(5) + 20, week, goal)).toMatchObject({ met: false, over: true, onTrack: false });
    expect(goalProgress(0, week, goal)).toMatchObject({ met: false, over: false, onTrack: true });
  });
});

describe("goalCategories", () => {
  it("lists categories with a goal, leaving out ignored ones", () => {
    const listed = goalCategories([
      category(1, { goal: { hours: 10, kind: "at_least" } }),
      category(2),
      category(3, { goal: { hours: 4, kind: "at_most" }, isIgnored: true }),
      category(4, { goal: { hours: 0, kind: "at_least" } }),
      category(5, { goal: { hours: 2, kind: "at_most" } }),
    ]);
    expect(listed.map((item) => item.id)).toEqual([1, 5]);
  });

  it("puts targets before limits, each by name", () => {
    const listed = goalCategories([
      category(1, { name: "video", goal: { hours: 4, kind: "at_most" } }),
      category(2, { name: "Writing", goal: { hours: 5, kind: "at_least" } }),
      category(3, { name: "Games", goal: { hours: 2, kind: "at_most" } }),
      category(4, { name: "reading", goal: { hours: 3, kind: "at_least" } }),
    ]);
    expect(listed.map((item) => item.name)).toEqual(["reading", "Writing", "Games", "video"]);
  });
});

describe("goal wording", () => {
  it("shows a prorated target to the minute without a trailing 0m", () => {
    expect(fmtGoalTarget(hours(80))).toBe("80h");
    expect(fmtGoalTarget(hours(10 / 7))).toBe("1h 25m");
    expect(fmtGoalTarget(hours(2 / 7))).toBe("17m");
  });

  it("labels targets and limits", () => {
    expect(goalTargetLabel(goalProgress(0, eightWeeks, { hours: 10, kind: "at_least" }))).toBe("of 80h");
    expect(goalTargetLabel(goalProgress(0, week, { hours: 2, kind: "at_most" }))).toBe("max 2h");
    expect(goalSummary({ hours: 10, kind: "at_least" })).toBe("at least 10h per week");
    expect(goalSummary({ hours: 5, kind: "at_most" })).toBe("at most 5h per week");
  });

  it("keeps fractional goals to the minute and writes them as durations", () => {
    expect(roundGoalHours(1.333)).toBeCloseTo(80 / 60, 10);
    expect(roundGoalHours(0.001)).toBe(0);
    expect(fmtGoalHours(2.25)).toBe("2h 15m");
    expect(fmtGoalHours(0.75)).toBe("45m");
    expect(fmtGoalHours(80 / 60)).toBe("1h 20m");
    expect(goalSummary({ hours: 1.5, kind: "at_most" })).toBe("at most 1h 30m per week");
    // Prorated as any goal is: 1.5h a week over a day is under 13 minutes.
    expect(goalTargetLabel(goalProgress(0, day, { hours: 1.5, kind: "at_most" }))).toBe("max 12m");
  });
});

describe("goalProgress missed", () => {
  const friday9am = new Date(2026, 9, 23, 9);

  it("crosses a target short for the days over, and a limit once passed", () => {
    expect(goalProgress(hours(5), week, { hours: 10, kind: "at_least" }, friday9am).missed).toBe(true);
    expect(goalProgress(hours(8), week, { hours: 10, kind: "at_least" }, friday9am).missed).toBe(false);
    expect(goalProgress(hours(3), week, { hours: 2, kind: "at_most" }, friday9am).missed).toBe(true);
    expect(goalProgress(hours(1), week, { hours: 2, kind: "at_most" }, friday9am).missed).toBe(false);
  });
});

describe("goalBarParts", () => {
  it("fills toward the goal while short of it", () => {
    expect(goalBarParts(5, 10)).toEqual({ within: 0.5, over: 0 });
  });

  it("spans the time once past the goal, keeping the goal's place", () => {
    // 18h against 15h: the goal at 15/18 of the bar, 3/18 beyond it.
    const parts = goalBarParts(18, 15);
    expect(parts.within).toBeCloseTo(15 / 18);
    expect(parts.over).toBeCloseTo(3 / 18);
  });

  it("draws nothing for nothing", () => {
    expect(goalBarParts(0, 0)).toEqual({ within: 0, over: 0 });
  });
});
