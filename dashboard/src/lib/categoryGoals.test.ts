import { describe, expect, it } from "vitest";

import type { Category } from "./classify";
import {
  fmtGoalTarget,
  goalCategories,
  goalProgress,
  goalSummary,
  goalTargetLabel,
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
    expect(goalSummary({ hours: 10, kind: "at_least" })).toBe("at least 10h/wk");
    expect(goalSummary({ hours: 5, kind: "at_most" })).toBe("at most 5h/wk");
  });
});
