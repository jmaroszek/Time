/**
 * Runs: unbroken stretches of time in one subject — an app, a website, a
 * category, a single window.
 *
 * Session rows are a poor unit for "how often" or "for how long at a time": the
 * tracker starts a new row on every title change, so an hour in one editor can
 * be forty rows, and every one of them used to count as a visit. A run joins a
 * subject's rows back together and ends only when the reader really left — went
 * idle, or stayed on something else long enough that it was not a glance.
 *
 * Insights' narrowed view and the Activity panels both count runs, and both do
 * it here, so the two can never describe the same history two different ways.
 */

/**
 * How long nothing at all may be recorded inside a run before it counts as two.
 *
 * Live sessions abut, so this mostly absorbs seams: a probe tick at a boundary,
 * a moment in an app Time is told not to record. It also spans the empty
 * heartbeat-length gap the legacy tracker left between consecutive rows of one
 * window, which would otherwise cut every migrated hour of a game into
 * fifteen-second-separated pieces. And it bounds a string of glances: however
 * short each one was, a reader gone for longer than this has left.
 */
export const RUN_GAP_TOLERANCE_SECONDS = 30;

/**
 * The longest stop elsewhere that is still a glance rather than a switch.
 *
 * Alt-tabbing to answer a message or skip a song and coming straight back is
 * part of the run it interrupted. Counting it as a break cut a working
 * afternoon into dozens of runs a few minutes long, which described the
 * reader's taskbar rather than their attention. Fifteen seconds is also the
 * legacy tracker's heartbeat, the smallest stop its migrated rows can record.
 */
export const RUN_GLANCE_SECONDS = 15;

/** What ends a run, in the words every surface that counts runs uses. */
export const RUN_DEFINITION =
  `A run ends when you go idle, or switch away for more than ${RUN_GLANCE_SECONDS} seconds at a time or ${RUN_GAP_TOLERANCE_SECONDS} in all.`;

/** What one recorded row is to the subject whose runs are being traced. */
export type RunRowKind =
  /** The subject itself. */
  | "in"
  /** Something else in the foreground. Ends a run unless it was a glance. */
  | "other"
  /** Idle time, which always ends a run, however short. */
  | "idle"
  /** Treated exactly as if nothing had been recorded — ignored activity. */
  | "unrecorded";

export interface RunSpan {
  start: number;
  end: number;
  /** Time in the subject. Less than `end - start` by any glances and seams the
   *  run spans, so the runs of a subject always add up to its total. */
  seconds: number;
  /** Indices, into the ordered rows, of the run's first and last rows. */
  first: number;
  last: number;
}

/** Rows by start time, sorted only when they are not already. */
export function orderedByStart<T extends { start: number; id: number }>(
  rows: readonly T[],
): readonly T[] {
  for (let index = 1; index < rows.length; index++) {
    if (rows[index - 1].start > rows[index].start) {
      return [...rows].sort((left, right) => left.start - right.start || left.id - right.id);
    }
  }
  return rows;
}

/**
 * The subject's runs within [startSec, endSec), from rows already ordered by
 * start (see `orderedByStart`).
 *
 * A run continues across a glance — a stop elsewhere of up to
 * RUN_GLANCE_SECONDS — and across a short stretch with nothing recorded, as
 * long as the subject is back within RUN_GAP_TOLERANCE_SECONDS of where it left
 * off. Anything longer elsewhere ends it, and so does going idle at all.
 */
export function collectRuns<T extends { start: number; end: number }>(
  rows: readonly T[],
  kindOf: (row: T) => RunRowKind,
  startSec: number,
  endSec: number,
): RunSpan[] {
  const runs: RunSpan[] = [];
  let run: RunSpan | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const start = Math.max(row.start, startSec);
    const end = Math.min(row.end, endSec);
    if (end <= start) continue;
    const kind = kindOf(row);
    if (kind === "unrecorded") continue;
    if (kind === "in") {
      if (run && start - run.end <= RUN_GAP_TOLERANCE_SECONDS) {
        run.end = Math.max(run.end, end);
        run.seconds += end - start;
        run.last = index;
      } else {
        if (run) runs.push(run);
        run = { start, end, seconds: end - start, first: index, last: index };
      }
    } else if (run && (kind === "idle" || end - start > RUN_GLANCE_SECONDS)) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs;
}

/**
 * The length at which half of the total sits in longer values and half in
 * shorter ones.
 *
 * An ordinary median of run lengths describes the *count* of runs, which for
 * anything used alongside other tools is mostly brief passes. Weighting by time
 * asks the question a reader means instead: what kind of stretch does a typical
 * minute of this belong to.
 */
export function timeWeightedMedian(values: readonly number[]): number | null {
  const sorted = values.filter((value) => value > 0).sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  let running = 0;
  for (const value of sorted) {
    running += value;
    if (running >= total / 2) return value;
  }
  return sorted[sorted.length - 1];
}

export interface RunStats {
  runs: number;
  /** Time in the subject across every run. */
  seconds: number;
  /** See `timeWeightedMedian`. Null when nothing was recorded. */
  typicalSeconds: number | null;
  longestSeconds: number | null;
}

export function runStats(runs: readonly RunSpan[]): RunStats {
  let seconds = 0;
  let longest = 0;
  // A loop rather than Math.max(...lengths): an all-time category can hold
  // more runs than a spread may pass as arguments.
  for (const run of runs) {
    seconds += run.seconds;
    if (run.seconds > longest) longest = run.seconds;
  }
  return {
    runs: runs.length,
    seconds,
    typicalSeconds: timeWeightedMedian(runs.map((run) => run.seconds)),
    longestSeconds: runs.length > 0 ? longest : null,
  };
}
