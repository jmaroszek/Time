// KPI and aggregation math over session rows. Pure functions, fully unit-tested.
// Sessions use unix SECONDS (DB native); Dates appear only at day/hour splits.

import type { Category, Classifier } from "./classify";
import { addDays, calendarDays, dayKey, listDays, type Range } from "./time";

export interface Session {
  id: number;
  start: number; // unix seconds
  end: number;
  process: string;
  title: string;
  domain: string | null;
  isAfk: boolean;
  categoryOverrideId?: number | null;
  isCorrected?: boolean;
}

/** Default max gap (s) between sessions that still counts as one continuous
 *  focus chain, when a caller doesn't supply one. */
// Mirrors the seeded focus_chain_max_gap_seconds default in tracker/db.py
// DEFAULT_SETTINGS — keep the two in lockstep.
const DEFAULT_FOCUS_CHAIN_MAX_GAP = 120;

export function duration(s: Session): number {
  return Math.max(0, s.end - s.start);
}

/** Clip sessions to [startSec, endSec); drops zero-length results. */
export function clipSessions(sessions: Session[], startSec: number, endSec: number): Session[] {
  const out: Session[] = [];
  forEachClippedSession(sessions, startSec, endSec, (session) => out.push(session));
  return out;
}

/** Visit clipped rows without materializing an intermediate array. Unchanged
 * rows retain their identity, which also keeps id/object caches effective. */
export function forEachClippedSession(
  sessions: Session[],
  startSec: number,
  endSec: number,
  visit: (session: Session) => void,
): void {
  for (const s of sessions) {
    const start = Math.max(s.start, startSec);
    const end = Math.min(s.end, endSec);
    if (end > start) visit(start === s.start && end === s.end ? s : { ...s, start, end });
  }
}

export interface DayChunk {
  dayStart: Date;
  startSec: number;
  endSec: number;
}

/** Visit local-day pieces without allocating the short-lived array used by the
 *  public `splitAtMidnights` convenience API. Hot aggregation paths use this. */
export function forEachDayChunk(
  startSec: number,
  endSec: number,
  visit: (chunk: DayChunk) => void,
): void {
  let cur = startSec;
  while (cur < endSec) {
    const d = new Date(cur * 1000);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const nextMidnight = addDays(dayStart, 1).getTime() / 1000;
    const chunkEnd = Math.min(endSec, nextMidnight);
    visit({ dayStart, startSec: cur, endSec: chunkEnd });
    cur = chunkEnd;
  }
}

/** Split an interval at local midnights. */
export function splitAtMidnights(startSec: number, endSec: number): DayChunk[] {
  const out: DayChunk[] = [];
  forEachDayChunk(startSec, endSec, (chunk) => out.push(chunk));
  return out;
}

// ---------------- KPIs ----------------

export interface Kpis {
  totalSec: number;
  prodSec: number;
  prodFraction: number;
  longestFocusSec: number;
}

export function computeKpis(
  sessions: Session[],
  classify: Classifier,
  focusChainMaxGapSec: number = DEFAULT_FOCUS_CHAIN_MAX_GAP,
): Kpis {
  let total = 0;
  let prod = 0;
  let longest = 0;
  let run = 0;
  let chainEnd: number | null = null;

  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    if (s.isAfk) {
      run = 0;
      chainEnd = null;
      continue;
    }
    const dur = duration(s);
    total += dur;
    const cat = classify(s);
    if (cat?.isProductive) {
      prod += dur;
      if (chainEnd !== null && s.start - chainEnd <= focusChainMaxGapSec) {
        run += dur;
      } else {
        run = dur;
      }
      chainEnd = s.end;
      longest = Math.max(longest, run);
    } else {
      run = 0;
      chainEnd = null;
    }
  }
  return {
    totalSec: total,
    prodSec: prod,
    prodFraction: total > 0 ? prod / total : 0,
    longestFocusSec: longest,
  };
}

// ---------------- goal pace ----------------

export interface GoalPace {
  doneHours: number;
  targetHours: number;
  fraction: number;
  /** Daily goal: weekly goal / 7. */
  dailyGoalHours: number;
  /** Trailing average productive hours per day over the range. */
  avgPerDayHours: number;
}

/**
 * Progress toward the goal over the selected window, plus a daily-average pace.
 * The target scales with the range (weekly goal × days / 7), so one day targets
 * the daily goal, seven days the full weekly goal, and so on proportionally.
 *
 * The presets are trailing windows that end today, with no future days left to
 * plan against, so pace is expressed as the trailing average per day measured
 * against the daily goal — not a per-remaining-day catch-up rate (which would
 * collapse the entire window's shortfall onto today).
 */
export function goalPace(prodSec: number, range: Range, weeklyGoalHours: number): GoalPace {
  const targetDays = calendarDays(range);
  const targetHours = (weeklyGoalHours * targetDays) / 7;
  const doneHours = prodSec / 3600;
  return {
    doneHours,
    targetHours,
    fraction: targetHours > 0 ? doneHours / targetHours : 0,
    dailyGoalHours: weeklyGoalHours / 7,
    avgPerDayHours: targetDays > 0 ? doneHours / targetDays : 0,
  };
}

// ---------------- top apps ----------------

export interface AppUsage {
  process: string;
  seconds: number;
  category: Category | null;
}

export function topApps(sessions: Session[], classify: Classifier): AppUsage[] {
  const byProcess = new Map<string, AppUsage>();
  for (const s of sessions) {
    if (s.isAfk) continue;
    let entry = byProcess.get(s.process);
    if (!entry) {
      entry = { process: s.process, seconds: 0, category: classify(s) };
      byProcess.set(s.process, entry);
    }
    entry.seconds += duration(s);
  }
  return [...byProcess.values()].sort((a, b) => b.seconds - a.seconds);
}

export type DeltaDirection = "good" | "bad" | "neutral";

export interface AppDelta extends AppUsage {
  /** Fractional change vs previous period; null when no previous data. */
  deltaFraction: number | null;
  /**
   * Fractional change recomputed with the single most-influential day removed;
   * null when no previous data or the range is too short to leave one out.
   */
  robustFraction: number | null;
  direction: DeltaDirection;
}

/** Seconds per day per process over the range's days (zero-filled arrays). */
export function dailySecondsByApp(sessions: Session[], range: Range): Map<string, number[]> {
  const dayKeys = listDays(range).map(dayKey);
  const indexByKey = new Map(dayKeys.map((k, i) => [k, i]));
  const out = new Map<string, number[]>();
  for (const s of sessions) {
    if (s.isAfk) continue;
    let arr = out.get(s.process);
    if (!arr) {
      arr = Array(dayKeys.length).fill(0);
      out.set(s.process, arr);
    }
    for (const chunk of splitAtMidnights(s.start, s.end)) {
      const i = indexByKey.get(dayKey(chunk.dayStart));
      if (i !== undefined) arr[i] += chunk.endSec - chunk.startSec;
    }
  }
  return out;
}

// ---- delta coloring thresholds ------------------------------------------
// A colored badge claims "your use of this app really changed". These gates
// encode that claim directly, as an effect size rather than an inference test.
//
// A significance test was tried first (Welch on daily usage) and removed: most
// apps are used in bursts on a minority of days, so at n=7 the test had almost
// no power and left four-digit percent changes gray, while its verdict swung
// with range length because longer windows buy power the user never asked for.
// Two weeks of usage are a census, not a sample — the honest question is how
// big the change was, not whether it is distinguishable from noise.
//
// The values below were tuned against 132 days of real history, bucketing
// badges by magnitude and checking that the colored share rises with it.
// Re-tune the same way rather than by intuition — the tests below pin the
// behavior each gate exists to produce.

/** Minimum fractional change worth coloring. */
const MIN_DELTA_FRACTION = 0.25;
/** Minimum absolute change, scaled by range length so 7d and 28d agree. */
const MIN_DELTA_SECONDS_PER_DAY = 4 * 60;
/** Minimum change that survives dropping the single most-influential day. */
const MIN_ROBUST_FRACTION = 0.15;
/** Leaving a day out is only meaningful once a few days remain. */
const MIN_DAYS_FOR_ROBUSTNESS = 3;

export interface DeltaOptions {
  /** Per-app daily seconds for the current/previous periods. */
  currentDaily?: Map<string, number[]>;
  previousDaily?: Map<string, number[]>;
}

/**
 * Recompute the change with the single day contributing most to it removed.
 * A week-long habit shift survives this; one long binge collapses toward zero.
 * Returns null when the daily series are absent or too short to leave one out.
 */
export function robustDeltaFraction(
  currentDaily: number[] | undefined,
  previousDaily: number[] | undefined,
): number | null {
  if (!currentDaily || !previousDaily) return null;
  const days = Math.min(currentDaily.length, previousDaily.length);
  if (days < MIN_DAYS_FOR_ROBUSTNESS) return null;
  let worst = 0;
  for (let i = 1; i < days; i++) {
    if (Math.abs(currentDaily[i] - previousDaily[i]) > Math.abs(currentDaily[worst] - previousDaily[worst])) {
      worst = i;
    }
  }
  let delta = 0;
  let base = 0;
  for (let i = 0; i < days; i++) {
    if (i === worst) continue;
    delta += currentDaily[i] - previousDaily[i];
    base += previousDaily[i];
  }
  if (base <= 0) return delta > 0 ? Infinity : 0;
  return delta / base;
}

/**
 * Category-aware delta coloring: more time in a productive category is good,
 * more time in a non-productive category is bad — and vice versa for declines.
 * A delta is colored only when the change is large in relative terms, large
 * enough in absolute terms to matter, and not the artifact of a single day.
 */
export function withDeltas(
  current: AppUsage[],
  previous: AppUsage[],
  opts: DeltaOptions = {},
): AppDelta[] {
  const prevByProcess = new Map(previous.map((a) => [a.process, a.seconds]));
  return current.map((app) => {
    const prev = prevByProcess.get(app.process) ?? 0;
    const deltaFraction = prev > 0 ? (app.seconds - prev) / prev : null;
    const cur = opts.currentDaily?.get(app.process);
    const prv = opts.previousDaily?.get(app.process);
    const robustFraction = deltaFraction === null ? null : robustDeltaFraction(cur, prv);
    let direction: DeltaDirection = "neutral";
    if (deltaFraction !== null && app.category !== null && deltaFraction !== 0) {
      const deltaSeconds = app.seconds - prev;
      const days = cur?.length ?? prv?.length ?? 1;
      const meaningful =
        Math.abs(deltaFraction) >= MIN_DELTA_FRACTION &&
        Math.abs(deltaSeconds) >= MIN_DELTA_SECONDS_PER_DAY * days &&
        // Without a usable daily series the range is too short to leave a day
        // out, and the size gates above stand on their own.
        (robustFraction === null ||
          (Math.sign(robustFraction) === Math.sign(deltaFraction) &&
            Math.abs(robustFraction) >= MIN_ROBUST_FRACTION));
      if (meaningful && !app.category.isNeutral) {
        // Neutral categories (e.g. games) are never judged good or bad.
        const increased = deltaFraction > 0;
        direction = increased === app.category.isProductive ? "good" : "bad";
      }
    }
    return { ...app, deltaFraction, robustFraction, direction };
  });
}

// ---------------- daily series ----------------

/** Seconds per day key, for sessions passing `include`; days are zero-filled. */
export function dailySeconds(
  sessions: Session[],
  include: (s: Session) => boolean,
  range: Range,
): Map<string, number> {
  const out = new Map<string, number>(listDays(range).map((d) => [dayKey(d), 0]));
  for (const s of sessions) {
    if (s.isAfk || !include(s)) continue;
    for (const chunk of splitAtMidnights(s.start, s.end)) {
      const key = dayKey(chunk.dayStart);
      if (out.has(key)) out.set(key, out.get(key)! + (chunk.endSec - chunk.startSec));
    }
  }
  return out;
}

/** Trailing mean over up to `window` values ending at each index. */
export function rollingMean(values: number[], window: number): number[] {
  return values.map((_v, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

// ---------------- hour-of-day matrix ----------------

/** [dayOfWeek 0=Sun][hour 0-23] -> seconds for sessions passing `include`. */
export function hourMatrix(sessions: Session[], include: (s: Session) => boolean): number[][] {
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of sessions) {
    if (s.isAfk || !include(s)) continue;
    let cur = s.start;
    while (cur < s.end) {
      const d = new Date(cur * 1000);
      // Component construction finds the next *local* hour boundary. UTC-hour
      // chunks smear :30/:45 zones and the repeated/skipped hour on DST days.
      const nextHour = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        d.getHours() + 1,
      ).getTime() / 1000;
      // The fallback only protects against exotic runtime timezone behavior;
      // supported zones always produce a boundary strictly after `cur`.
      const chunkEnd = Math.min(s.end, nextHour > cur ? nextHour : cur + 3600);
      matrix[d.getDay()][d.getHours()] += chunkEnd - cur;
      cur = chunkEnd;
    }
  }
  return matrix;
}
