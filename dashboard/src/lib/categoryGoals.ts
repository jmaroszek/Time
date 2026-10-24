// Weekly goals per category: the arithmetic and the words, kept apart from the
// components so the popover, the narrowed tile and Settings all say the same.

import type { Category, CategoryGoal, GoalKind } from "./classify";
import { fmtExactDuration } from "./format";
import { proratedTargetHours } from "./metrics";
import type { Range } from "./time";

/** The goal range, the same 0–100 as the overall goal in Settings. 0 removes. */
export const GOAL_MAX_HOURS = 100;

export interface GoalProgress {
  kind: GoalKind;
  doneSeconds: number;
  targetSeconds: number;
  /** An "at least" goal reached. Never true for a limit: staying under one is
   *  not an achievement the period can complete. */
  met: boolean;
  /** An "at most" goal exceeded. Never true for a target. */
  over: boolean;
  /** Met for a target, not over for a limit. What "2 of 3 on track" counts. */
  onTrack: boolean;
  /** Done over target, for a progress bar. Unclamped. */
  fraction: number;
}

/**
 * Where a goal stands over a range. Exact comparisons, never rounded ones: a
 * limit 20 seconds over is over, whatever the figure beside it rounds to.
 */
export function goalProgress(seconds: number, range: Range, goal: CategoryGoal): GoalProgress {
  const targetSeconds = proratedTargetHours(goal.hours, range) * 3600;
  const met = goal.kind === "at_least" && seconds >= targetSeconds;
  const over = goal.kind === "at_most" && seconds > targetSeconds;
  return {
    kind: goal.kind,
    doneSeconds: seconds,
    targetSeconds,
    met,
    over,
    onTrack: goal.kind === "at_least" ? met : !over,
    fraction: targetSeconds > 0 ? seconds / targetSeconds : 0,
  };
}

/** Categories whose goals Insights shows, in list order. Ignored time is never
 *  counted, so a goal on an ignored category could only ever read zero. */
export function goalCategories(categories: Category[]): Array<Category & { goal: CategoryGoal }> {
  return categories.filter(
    (category): category is Category & { goal: CategoryGoal } =>
      !category.isIgnored && category.goal !== undefined && category.goal.hours > 0,
  );
}

/**
 * A prorated target to the minute, without a trailing "0m": "80h", "4h 17m",
 * "17m". Whole hours alone would hide what decides the state — a 1h 40m week
 * against a limit shown as "max 2h" reads as under it when the real limit,
 * 1h 34m on a short range, has already been passed.
 */
export function fmtGoalTarget(targetSeconds: number): string {
  return fmtExactDuration(targetSeconds).replace(/ 0m$/, "");
}

/** The small text after the figure: "of 80h" for a target, "max 2h" for a limit. */
export function goalTargetLabel(progress: GoalProgress): string {
  return `${progress.kind === "at_most" ? "max" : "of"} ${fmtGoalTarget(progress.targetSeconds)}`;
}

/** The goal as set, unprorated: "at least 10h/wk", "at most 5h/wk". */
export function goalSummary(goal: CategoryGoal): string {
  return `${goal.kind === "at_most" ? "at most" : "at least"} ${goal.hours}h/wk`;
}
