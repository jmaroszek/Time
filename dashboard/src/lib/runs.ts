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
 * How long a run may be away — elsewhere, or with nothing recorded — and still
 * be one sitting.
 *
 * Alt-tabbing to answer a message, check a process, or change a mouse profile
 * and coming back is part of the run it interrupted. Fifteen seconds was too
 * tight for that: in a real history most splits of an evening's game were
 * trips of twenty seconds to a minute and a half, which described the
 * reader's taskbar rather than their attention. Time away adds up across
 * consecutive stops, so a string of short ones cannot stretch a run either.
 *
 * It also spans seams: a probe tick at a boundary, a moment in an app Time is
 * told not to record, and the heartbeat-length gap the legacy tracker left
 * between consecutive rows of one window.
 */
export const RUN_AWAY_SECONDS = 120;

/**
 * How much idle time a run may span before it counts as two.
 *
 * Idle under a few minutes is usually not leaving: a controller set down for a
 * cutscene, a video watched to the end, reading a long page. Ending a run at
 * any idle split those into separate sittings whenever the pause crossed the
 * AFK threshold, which is the reader's own setting and often short. The idle
 * itself stays out of the run's time; this only decides whether what comes
 * after it is the same sitting.
 */
export const RUN_IDLE_SECONDS = 600;

/** What ends a run, in the words every surface that counts runs uses. */
export const RUN_DEFINITION =
  `A run ends when you switch to something else for more than ${RUN_AWAY_SECONDS / 60} minutes, or go idle for more than ${RUN_IDLE_SECONDS / 60}.`;

/** What one recorded row is to the subject whose runs are being traced. */
export type RunRowKind =
  /** The subject itself. */
  | "in"
  /** Something else in the foreground. Counts toward RUN_AWAY_SECONDS. */
  | "other"
  /** Idle time. Counts toward RUN_IDLE_SECONDS, not toward time away. */
  | "idle"
  /** Treated exactly as if nothing had been recorded — ignored activity. */
  | "unrecorded";

export interface RunSpan {
  start: number;
  end: number;
  /** Time in the subject. Less than `end - start` by any time away and idle
   *  the run spans, so the runs of a subject always add up to its total. */
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
 * A run continues while the subject comes back with no more than
 * RUN_IDLE_SECONDS of idle and RUN_AWAY_SECONDS of anything else — another
 * subject, or nothing recorded — since it left. The two budgets are separate:
 * idle is a pause in the sitting, and time elsewhere is a departure from it.
 */
export function collectRuns<T extends { start: number; end: number }>(
  rows: readonly T[],
  kindOf: (row: T) => RunRowKind,
  startSec: number,
  endSec: number,
): RunSpan[] {
  const runs: RunSpan[] = [];
  let run: RunSpan | null = null;
  // Idle since the run's last row in the subject. Time away is everything
  // else since then, which spans unrecorded seams without listing them.
  let idle = 0;
  const close = () => {
    if (run) runs.push(run);
    run = null;
    idle = 0;
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const start = Math.max(row.start, startSec);
    const end = Math.min(row.end, endSec);
    if (end <= start) continue;
    const kind = kindOf(row);
    if (kind === "unrecorded") continue;
    if (kind === "in") {
      if (run && start - run.end - idle <= RUN_AWAY_SECONDS) {
        run.end = Math.max(run.end, end);
        run.seconds += end - start;
        run.last = index;
        idle = 0;
      } else {
        close();
        run = { start, end, seconds: end - start, first: index, last: index };
      }
    } else if (run) {
      if (kind === "idle") idle += end - start;
      // Closing as soon as either budget is spent is what bounds idle: the
      // check on return subtracts idle and looks only at time away.
      if (idle > RUN_IDLE_SECONDS || end - run.end - idle > RUN_AWAY_SECONDS) close();
    }
  }
  close();
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
