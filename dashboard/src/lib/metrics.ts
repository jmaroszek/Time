// KPI and aggregation math over session rows. Pure functions, fully unit-tested.
// Sessions use unix SECONDS (DB native); Dates appear only at day/hour splits.

import type { Category, Classifier } from "./classify";
import { appGroupKey, cleanDomainName, cleanProcessName } from "./format";
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

/** Default max gap (s) of *untracked* time between productive sessions that
 *  still counts as one continuous focus chain, when a caller doesn't supply
 *  one. Neutral and uncategorized activity preserve an existing chain without
 *  adding to its productive duration; unproductive or AFK time ends it. */
// Mirrors the seeded focus_chain_max_gap_seconds default in tracker/db.py
// DEFAULT_SETTINGS — keep the two in lockstep.
const DEFAULT_FOCUS_CHAIN_MAX_GAP = 300;

/** A category breaks focus only when the user explicitly classified it as
 *  unproductive. Neutral and not-yet-classified activity carry an existing
 *  chain forward; AFK is handled separately because it has no category. */
export function isFocusChainBreaker(category: Category | null): boolean {
  return category !== null && !category.isProductive && !category.isNeutral;
}

/** Running focus-chain state: see `focusChain`. */
export interface FocusChain {
  /**
   * Fold one non-AFK span into the chain. `startSec`/`endSec` bound the span in
   * wall-clock terms and `seconds` is what it contributes — the two differ once
   * a session has been clipped to a range or split at a day boundary, and it is
   * the wall-clock pair that decides whether the gap since the last productive
   * span is small enough to keep the chain alive.
   */
  add(startSec: number, endSec: number, seconds: number, category: Category | null): void;
  /** End the chain outright. AFK has no category to test, so it says so here. */
  breakChain(): void;
  /** Longest productive run seen so far, in seconds. */
  readonly longestSeconds: number;
}

/**
 * The focus-chain rule, in one place: productive time extends a chain and is
 * counted; neutral and uncategorized activity carry a chain across without
 * adding to it; unproductive activity and AFK end it; and a gap of untracked
 * time longer than `maxGapSec` ends it too.
 *
 * Every view that reports focus — the KPI row, the day and month calendars, the
 * Insights history — has to answer this the same way, or two surfaces disagree
 * about the same day. They did each hold their own copy of the ladder.
 */
export function focusChain(maxGapSec: number = DEFAULT_FOCUS_CHAIN_MAX_GAP): FocusChain {
  let run = 0;
  let chainEnd: number | null = null;
  let longest = 0;
  return {
    add(startSec, endSec, seconds, category) {
      if (category?.isProductive) {
        run = chainEnd !== null && startSec - chainEnd <= maxGapSec ? run + seconds : seconds;
        chainEnd = endSec;
        longest = Math.max(longest, run);
      } else if (isFocusChainBreaker(category)) {
        run = 0;
        chainEnd = null;
      } else if (chainEnd !== null) {
        // Neutral or uncategorized: bridge the chain if it is still close
        // enough, otherwise the gap has ended it.
        if (startSec - chainEnd <= maxGapSec) {
          chainEnd = Math.max(chainEnd, endSec);
        } else {
          run = 0;
          chainEnd = null;
        }
      }
    },
    breakChain() {
      run = 0;
      chainEnd = null;
    },
    get longestSeconds() {
      return longest;
    },
  };
}

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
  /** Tracked seconds no rule claimed. Equal to totalSec means nothing in the
   *  range is classified at all, which is a different statement from "none of
   *  it was productive" and the two read identically as a bare zero. */
  uncategorizedSec: number;
}

export function computeKpis(
  sessions: Session[],
  classify: Classifier,
  focusChainMaxGapSec: number = DEFAULT_FOCUS_CHAIN_MAX_GAP,
): Kpis {
  let total = 0;
  let prod = 0;
  let uncategorized = 0;
  const chain = focusChain(focusChainMaxGapSec);

  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    if (s.isAfk) {
      chain.breakChain();
      continue;
    }
    const dur = duration(s);
    total += dur;
    const cat = classify(s);
    if (cat?.isProductive) prod += dur;
    if (!cat) uncategorized += dur;
    chain.add(s.start, s.end, dur, cat);
  }
  return {
    totalSec: total,
    prodSec: prod,
    prodFraction: total > 0 ? prod / total : 0,
    longestFocusSec: chain.longestSeconds,
    uncategorizedSec: uncategorized,
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
  /** Exact target state; display rounding must never decide completion. */
  met: boolean;
  /** Rounded figures look equal although the exact target is still ahead. */
  roundedTieWhileBehind: boolean;
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
  const met = doneHours >= targetHours;
  return {
    doneHours,
    targetHours,
    fraction: targetHours > 0 ? doneHours / targetHours : 0,
    dailyGoalHours: weeklyGoalHours / 7,
    avgPerDayHours: targetDays > 0 ? doneHours / targetDays : 0,
    met,
    roundedTieWhileBehind:
      !met && Math.round(doneHours) === Math.round(targetHours),
  };
}

// ---------------- ranked apps and websites ----------------

export interface RankedUsage {
  key: string;
  name: string;
  seconds: number;
  category: Category | null;
}

export interface AppUsage extends RankedUsage {
  /** Row identity — see `appGroupKey`. Processes sharing an alias share a row. */
  key: string;
  /** What the row is labeled, in the alias's own casing. */
  name: string;
  /** Raw process names folded into this row, sorted. Usually one; more once a
   *  user has aliased several executables to the same name. Callers that need a
   *  real process — a rule to write, a browser to test for — must consult all
   *  of them rather than assuming a single member. */
  processes: string[];
}

/** An app row mid-build. `categorySeconds` exists only to settle the row's
 *  category once every session has landed; see `rankAppUsage`. */
export interface AppUsageAccumulator {
  key: string;
  name: string;
  processes: Set<string>;
  seconds: number;
  /** Keyed by category id, null for unclassified. */
  categorySeconds: Map<number | null, { category: Category | null; seconds: number }>;
}

/**
 * Fold one session's seconds into its app row. Insights runs its own single
 * ordered pass rather than calling `topApps`, so both paths share this to stay
 * on one definition of what an app row is — `insights.test.ts` asserts the two
 * agree, and that assertion is only worth something while they share this.
 */
export function addAppSeconds(
  into: Map<string, AppUsageAccumulator>,
  process: string,
  aliases: Record<string, string> | undefined,
  category: Category | null,
  seconds: number,
): void {
  const key = appGroupKey(process, aliases);
  let row = into.get(key);
  if (!row) {
    row = {
      key,
      name: cleanProcessName(process, aliases),
      processes: new Set<string>(),
      seconds: 0,
      categorySeconds: new Map(),
    };
    into.set(key, row);
  }
  row.processes.add(process);
  row.seconds += seconds;
  const id = category?.id ?? null;
  const bucket = row.categorySeconds.get(id);
  if (bucket) bucket.seconds += seconds;
  else row.categorySeconds.set(id, { category, seconds });
}

/**
 * The category a row is labeled with: whichever holds most of its seconds.
 *
 * A row built from one process has exactly one category and is unaffected. A
 * merged row can span several — two builds of the same app classified apart —
 * and the majority is the only answer that stays put as time accumulates.
 * Ties break toward the lower category id, and toward any real category over
 * unclassified, so the label never depends on session order.
 */
function dominantCategory(
  buckets: Map<number | null, { category: Category | null; seconds: number }>,
): Category | null {
  let best: { category: Category | null; seconds: number } | null = null;
  for (const bucket of buckets.values()) {
    if (best === null || bucket.seconds > best.seconds) {
      best = bucket;
      continue;
    }
    if (bucket.seconds < best.seconds) continue;
    if (best.category === null) best = bucket;
    else if (bucket.category !== null && bucket.category.id < best.category.id) best = bucket;
  }
  return best?.category ?? null;
}

/** Finish and rank accumulated rows. Equal totals break by key so a merge that
 *  produces a tie still orders the same way on every rebuild. */
export function rankAppUsage(rows: Map<string, AppUsageAccumulator>): AppUsage[] {
  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      name: row.name,
      processes: [...row.processes].sort(),
      seconds: row.seconds,
      category: dominantCategory(row.categorySeconds),
    }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
}

export interface WebsiteUsage extends RankedUsage {
  /** Exact normalized hostname. Unlike app aliases, friendly website names do
   *  not merge identities: two subdomains remain two analytical destinations. */
  domain: string;
}

export interface WebsiteUsageAccumulator {
  key: string;
  name: string;
  domain: string;
  seconds: number;
  categorySeconds: Map<number | null, { category: Category | null; seconds: number }>;
}

/** Fold detected browser time into one exact-host website row. `www.` has
 * already been removed by the tracker; every remaining subdomain is retained. */
export function addWebsiteSeconds(
  into: Map<string, WebsiteUsageAccumulator>,
  domain: string,
  aliases: Record<string, string> | undefined,
  category: Category | null,
  seconds: number,
): void {
  const key = domain.toLowerCase();
  let row = into.get(key);
  if (!row) {
    row = {
      key,
      name: cleanDomainName(domain, aliases),
      domain,
      seconds: 0,
      categorySeconds: new Map(),
    };
    into.set(key, row);
  }
  row.seconds += seconds;
  const id = category?.id ?? null;
  const bucket = row.categorySeconds.get(id);
  if (bucket) bucket.seconds += seconds;
  else row.categorySeconds.set(id, { category, seconds });
}

export function rankWebsiteUsage(
  rows: Map<string, WebsiteUsageAccumulator>,
): WebsiteUsage[] {
  return [...rows.values()]
    .map((row) => ({
      key: row.key,
      name: row.name,
      domain: row.domain,
      seconds: row.seconds,
      category: dominantCategory(row.categorySeconds),
    }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
}

export function topApps(
  sessions: Session[],
  classify: Classifier,
  aliases?: Record<string, string>,
): AppUsage[] {
  const rows = new Map<string, AppUsageAccumulator>();
  for (const s of sessions) {
    if (s.isAfk) continue;
    addAppSeconds(rows, s.process, aliases, classify(s), duration(s));
  }
  return rankAppUsage(rows);
}

/** Seconds under the display name grouping `process`, for the "Top app" line in
 *  heatmap and calendar tooltips. Same grouping as the Top Apps list, so a
 *  merged app cannot lead one and be split across the other. */
export function addTopAppSeconds(
  into: Map<string, { name: string; seconds: number }>,
  process: string,
  aliases: Record<string, string> | undefined,
  seconds: number,
): void {
  const key = appGroupKey(process, aliases);
  const row = into.get(key);
  if (row) row.seconds += seconds;
  else into.set(key, { name: cleanProcessName(process, aliases), seconds });
}

/** Busiest entry of an `addTopAppSeconds` map, ties breaking by name so the
 *  tooltip doesn't change between rebuilds. */
export function topAppOf(
  apps: Map<string, { name: string; seconds: number }>,
): { name: string; seconds: number } | null {
  let top: { name: string; seconds: number } | null = null;
  for (const app of apps.values()) {
    if (!top || app.seconds > top.seconds || (app.seconds === top.seconds && app.name < top.name)) {
      top = app;
    }
  }
  return top;
}

export type DeltaDirection = "good" | "bad" | "neutral";

export interface UsageDelta {
  /** Fractional change vs previous period; null when no previous data. */
  deltaFraction: number | null;
  /** Seconds in the previous period, for phrasing the change. */
  previousSeconds: number;
  /**
   * True when the previous period holds too little time to divide by, so
   * `deltaFraction` is arithmetically correct but not worth quoting.
   */
  baselineNegligible: boolean;
  /**
   * Fractional change recomputed with the single most-influential day removed;
   * null when no previous data or the range is too short to leave one out.
   */
  robustFraction: number | null;
  direction: DeltaDirection;
}

export type AppDelta = AppUsage & UsageDelta;
export type WebsiteDelta = WebsiteUsage & UsageDelta;

/** Seconds per day per app row over the range's days (zero-filled arrays),
 *  keyed by `appGroupKey` to match the rows these series are looked up by. */
export function dailySecondsByApp(
  sessions: Session[],
  range: Range,
  aliases?: Record<string, string>,
): Map<string, number[]> {
  const dayKeys = listDays(range).map(dayKey);
  const indexByKey = new Map(dayKeys.map((k, i) => [k, i]));
  const out = new Map<string, number[]>();
  for (const s of sessions) {
    if (s.isAfk) continue;
    const key = appGroupKey(s.process, aliases);
    let arr = out.get(key);
    if (!arr) {
      arr = Array(dayKeys.length).fill(0);
      out.set(key, arr);
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
/**
 * Below this previous-period average the baseline is noise, and a ratio built
 * on it says more about the divisor than about the change: a few stray minutes
 * last week against a full week of use reads as "+51698%". Callers show these
 * as resumed rather than quoting the number.
 */
const MIN_BASELINE_SECONDS_PER_DAY = 60;

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
export function withDeltas<T extends RankedUsage>(
  current: T[],
  previous: Array<Pick<RankedUsage, "key" | "seconds">>,
  opts: DeltaOptions = {},
): Array<T & UsageDelta> {
  const prevByKey = new Map(previous.map((a) => [a.key, a.seconds]));
  return current.map((app) => {
    const prev = prevByKey.get(app.key) ?? 0;
    const deltaFraction = prev > 0 ? (app.seconds - prev) / prev : null;
    const cur = opts.currentDaily?.get(app.key);
    const prv = opts.previousDaily?.get(app.key);
    const robustFraction = deltaFraction === null ? null : robustDeltaFraction(cur, prv);
    const days = cur?.length ?? prv?.length ?? 1;
    const baselineNegligible = prev > 0 && prev < MIN_BASELINE_SECONDS_PER_DAY * days;
    let direction: DeltaDirection = "neutral";
    if (deltaFraction !== null && app.category !== null && deltaFraction !== 0) {
      const deltaSeconds = app.seconds - prev;
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
    return { ...app, deltaFraction, previousSeconds: prev, baselineNegligible, robustFraction, direction };
  });
}

// ---------------- daily series ----------------

/** Trailing mean over up to `window` values ending at each index. */
export function rollingMean(values: number[], window: number): number[] {
  return values.map((_v, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

export type ProductivityDataState = "nothing-recorded" | "nothing-classified" | "ready";

export function productivityDataState(kpis: Kpis): ProductivityDataState {
  if (kpis.totalSec === 0) return "nothing-recorded";
  if (kpis.uncategorizedSec === kpis.totalSec) return "nothing-classified";
  return "ready";
}

/** Trailing mean over observed values only; unavailable positions stay gaps. */
export function rollingMeanObserved(
  values: Array<number | null>,
  window: number,
): Array<number | null> {
  const observed: number[] = [];
  return values.map((value) => {
    if (value === null) return null;
    observed.push(value);
    const slice = observed.slice(Math.max(0, observed.length - window));
    return slice.reduce((total, item) => total + item, 0) / slice.length;
  });
}
