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
}

/** Max gap (s) between sessions that still counts as one continuous focus chain. */
const FOCUS_CHAIN_MAX_GAP = 60;

export function duration(s: Session): number {
  return Math.max(0, s.end - s.start);
}

/** Clip sessions to [startSec, endSec); drops zero-length results. */
export function clipSessions(sessions: Session[], startSec: number, endSec: number): Session[] {
  const out: Session[] = [];
  for (const s of sessions) {
    const start = Math.max(s.start, startSec);
    const end = Math.min(s.end, endSec);
    if (end > start) out.push({ ...s, start, end });
  }
  return out;
}

export interface DayChunk {
  dayStart: Date;
  startSec: number;
  endSec: number;
}

/** Split an interval at local midnights. */
export function splitAtMidnights(startSec: number, endSec: number): DayChunk[] {
  const out: DayChunk[] = [];
  let cur = startSec;
  while (cur < endSec) {
    const d = new Date(cur * 1000);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const nextMidnight = addDays(dayStart, 1).getTime() / 1000;
    const chunkEnd = Math.min(endSec, nextMidnight);
    out.push({ dayStart, startSec: cur, endSec: chunkEnd });
    cur = chunkEnd;
  }
  return out;
}

// ---------------- KPIs ----------------

export interface Kpis {
  totalSec: number;
  prodSec: number;
  prodFraction: number;
  longestFocusSec: number;
}

export function computeKpis(sessions: Session[], classify: Classifier): Kpis {
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
      if (chainEnd !== null && s.start - chainEnd <= FOCUS_CHAIN_MAX_GAP) {
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
  /** Hours per remaining day needed to hit target; 0 when period is over or met. */
  needPerDayHours: number;
  remainingDays: number;
}

/**
 * Target scales with range length but is never less than one full weekly goal,
 * so a partial "this week" compares against the whole week's goal (legacy
 * progress-bar semantics preserved).
 */
export function goalPace(
  prodSec: number,
  range: Range,
  weeklyGoalHours: number,
  now: Date = new Date(),
): GoalPace {
  const nDays = calendarDays(range);
  const targetDays = Math.max(nDays, 7);
  const targetHours = (weeklyGoalHours * targetDays) / 7;
  const doneHours = prodSec / 3600;

  const periodEnd = addDays(range.start, targetDays);
  const msLeft = periodEnd.getTime() - now.getTime();
  const remainingDays = Math.min(Math.max(Math.ceil(msLeft / 86_400_000), 0), targetDays);
  const needPerDayHours =
    remainingDays > 0 ? Math.max(0, targetHours - doneHours) / remainingDays : 0;

  return {
    doneHours,
    targetHours,
    fraction: targetHours > 0 ? doneHours / targetHours : 0,
    needPerDayHours,
    remainingDays,
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
  /** Welch two-sided p-value on daily usage; null when not computable. */
  pValue: number | null;
  direction: DeltaDirection;
}

// ---- Welch's t-test (two-sided) on daily usage samples -------------------
// p-value via the identity  P(|T| > |t|) = I_x(df/2, 1/2),  x = df/(df + t²),
// with the regularized incomplete beta computed by continued fraction
// (Numerical Recipes betacf). Pinned to scipy reference values in tests.

function lnGamma(x: number): number {
  // Lanczos approximation, g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regIncBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided Welch t-test p-value; null when either sample has n < 2. */
export function welchTTestPValue(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  const variance = (v: number[], m: number) =>
    v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1);
  const sa = variance(a, ma) / a.length;
  const sb = variance(b, mb) / b.length;
  const denom = sa + sb;
  if (denom === 0) return ma === mb ? 1 : 0;
  const t = (ma - mb) / Math.sqrt(denom);
  const df = (denom * denom) / ((sa * sa) / (a.length - 1) + (sb * sb) / (b.length - 1));
  return regIncBeta(df / 2, 0.5, df / (df + t * t));
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

export interface DeltaOptions {
  /** Per-app daily seconds for the current/previous periods (for the t-test). */
  currentDaily?: Map<string, number[]>;
  previousDaily?: Map<string, number[]>;
  /** Significance level for coloring; default 0.1. */
  alpha?: number;
}

/**
 * Category-aware delta coloring: more time in a productive category is good,
 * more time in a non-productive category is bad — and vice versa for declines.
 * A delta only gets colored when it is statistically distinguishable from
 * "business as usual": Welch's t-test on daily usage when daily samples are
 * available (n >= 2 days per side), otherwise a coarse fallback requiring a
 * >=25% change of at least 15 minutes.
 */
export function withDeltas(
  current: AppUsage[],
  previous: AppUsage[],
  opts: DeltaOptions = {},
): AppDelta[] {
  const alpha = opts.alpha ?? 0.1;
  const prevByProcess = new Map(previous.map((a) => [a.process, a.seconds]));
  return current.map((app) => {
    const prev = prevByProcess.get(app.process) ?? 0;
    const deltaFraction = prev > 0 ? (app.seconds - prev) / prev : null;
    let direction: DeltaDirection = "neutral";
    let pValue: number | null = null;
    if (deltaFraction !== null && app.category !== null && deltaFraction !== 0) {
      const cur = opts.currentDaily?.get(app.process);
      const prv = opts.previousDaily?.get(app.process);
      if (cur && prv) pValue = welchTTestPValue(cur, prv);
      const significant =
        pValue !== null
          ? pValue < alpha
          : Math.abs(deltaFraction) >= 0.25 && Math.abs(app.seconds - prev) >= 900;
      if (significant) {
        const increased = deltaFraction > 0;
        direction = increased === app.category.isProductive ? "good" : "bad";
      }
    }
    return { ...app, deltaFraction, pValue, direction };
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
      const nextHour = (Math.floor(cur / 3600) + 1) * 3600;
      const chunkEnd = Math.min(s.end, nextHour);
      const d = new Date(cur * 1000);
      matrix[d.getDay()][d.getHours()] += chunkEnd - cur;
      cur = chunkEnd;
    }
  }
  return matrix;
}
