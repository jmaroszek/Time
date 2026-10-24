// Weekly goals per category: the arithmetic and the words, kept apart from the
// components so the popover, the narrowed tile and Settings all say the same.

import type { Category, CategoryGoal, GoalKind } from "./classify";
import { fmtExactDuration } from "./format";
import { goalMissed, proratedTargetHours } from "./metrics";
import type { Range } from "./time";

/** The goal range, the same 0–100 as the overall goal in Settings. 0 removes. */
export const GOAL_MAX_HOURS = 100;

/**
 * Hours as a goal stores them: to the nearest minute. Goals may be fractional
 * (1.5, 2.25), and a minute is the finest a figure beside them ever shows, so
 * an entry like 1.333 can't leave a target that never reads as a round number.
 */
export function roundGoalHours(hours: number): number {
  return Math.round(hours * 60) / 60;
}

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
  /** Settled the wrong way: a limit passed, or a target short even for the
   *  days already over (see `goalMissed`). What the red cross marks. */
  missed: boolean;
  /** Done over target, for a progress bar. Unclamped. */
  fraction: number;
}

/**
 * Where a goal stands over a range. Exact comparisons, never rounded ones: a
 * limit 20 seconds over is over, whatever the figure beside it rounds to.
 */
export function goalProgress(
  seconds: number,
  range: Range,
  goal: CategoryGoal,
  now: Date = new Date(),
): GoalProgress {
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
    missed: goal.kind === "at_least" ? !met && goalMissed(seconds / 3600, goal.hours, range, now) : over,
    fraction: targetSeconds > 0 ? seconds / targetSeconds : 0,
  };
}

/**
 * A progress bar's two parts, as shares of its full width. The bar spans the
 * larger of the time and the goal, so a goal passed still shows where the
 * goal was and, beyond it, by how much: 18h against 15h is 15 parts to the
 * goal and 3 past it. Short of the goal, `within` is the whole story and
 * the rest of the track is what's left.
 */
export function goalBarParts(done: number, target: number): { within: number; over: number } {
  const scale = Math.max(done, target);
  if (scale <= 0) return { within: 0, over: 0 };
  return {
    within: Math.min(done, target) / scale,
    over: Math.max(0, done - target) / scale,
  };
}

/**
 * Categories whose goals Insights and Settings list: targets, then limits,
 * each by name. Two groups because the two read in opposite directions, more
 * is better for one and worse for the other. By name within them because the
 * stored order is
 * only when each category was made, which nothing shows or lets you change,
 * and a status order would move rows every time a goal changed state.
 * Ignored time is never counted, so a goal on an ignored category could only
 * ever read zero.
 */
export function goalCategories(categories: Category[]): Array<Category & { goal: CategoryGoal }> {
  return categories
    .filter(
      (category): category is Category & { goal: CategoryGoal } =>
        !category.isIgnored && category.goal !== undefined && category.goal.hours > 0,
    )
    .sort((a, b) =>
      (a.goal.kind === b.goal.kind ? 0 : a.goal.kind === "at_least" ? -1 : 1)
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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

/** Goal hours as the rest of the app writes a duration: "10h", "2h 15m", "45m". */
export function fmtGoalHours(hours: number): string {
  return fmtGoalTarget(roundGoalHours(hours) * 3600);
}

/** The goal as set, unprorated: "at least 10h per week", "at most 1h 30m per week". */
export function goalSummary(goal: CategoryGoal): string {
  return `${goal.kind === "at_most" ? "at most" : "at least"} ${fmtGoalHours(goal.hours)} per week`;
}
