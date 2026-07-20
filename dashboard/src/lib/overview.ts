import { categoryKind, type Classifier } from "./classify";
import {
  forEachClippedSession,
  forEachDayChunk,
  type Session,
} from "./metrics";
import {
  addDays,
  calendarDays,
  dayKey,
  listDays,
  startOfDay,
  startOfWeek,
  type Range,
  type WeekStart,
} from "./time";

export type OverviewGranularity = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Which quantity a heatmap shades by. Both the rhythm grid and the calendar
 * honor it, and the ramp follows it — blue for amount, green for productive,
 * red-orange for unproductive, gray for neutral — so the color carries its own
 * legend across either view.
 */
export type ActivityMetric = "tracked" | "productive" | "unproductive" | "neutral";

export const ACTIVITY_METRICS: ActivityMetric[] = [
  "tracked",
  "productive",
  "unproductive",
  "neutral",
];

/** Dropdown label per metric. "Total" rather than "Tracked" — the control is
 *  read next to the others, where "total vs productive" is the clearer pair. */
export const ACTIVITY_METRIC_LABELS: Record<ActivityMetric, string> = {
  tracked: "Total time",
  productive: "Productive time",
  unproductive: "Unproductive time",
  neutral: "Neutral time",
};

/** Adjective for chart subtitles and tooltip rows. */
export const ACTIVITY_METRIC_WORDS: Record<ActivityMetric, string> = {
  tracked: "tracked",
  productive: "productive",
  unproductive: "unproductive",
  neutral: "neutral",
};

/** Stack decomposition for the activity-hours bars: the productive/neutral/
 *  unproductive taxonomy, or the user's own categories. */
export type ActivityStack = "state" | "category";

/** Bucket key for sessions no rule matched. Categories cannot be named this
 *  without colliding, which is acceptable — it is already the label the charts
 *  and tooltips use for the same thing. */
export const UNCATEGORIZED_LABEL = "Uncategorized";

/** The four state totals every heatmap bucket carries, whatever it is keyed by. */
export interface ActivityTotals {
  trackedSeconds: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
}

function addCategorySeconds(
  into: Map<string, number>,
  categoryName: string | undefined,
  seconds: number,
): void {
  const key = categoryName ?? UNCATEGORIZED_LABEL;
  into.set(key, (into.get(key) ?? 0) + seconds);
}

export function metricSeconds(totals: ActivityTotals, metric: ActivityMetric): number {
  switch (metric) {
    case "productive":
      return totals.productiveSeconds;
    case "unproductive":
      return totals.unproductiveSeconds;
    case "neutral":
      return totals.neutralSeconds;
    case "tracked":
      return totals.trackedSeconds;
  }
}

/** The metric's whole-percent share of tracked time, or null when it carries no
 *  meaning: for tracked itself (always 100%) or an empty cell. */
export function metricTrackedShare(totals: ActivityTotals, metric: ActivityMetric): number | null {
  if (metric === "tracked" || totals.trackedSeconds <= 0) return null;
  return Math.round((metricSeconds(totals, metric) / totals.trackedSeconds) * 100);
}

/** Past two years, monthly bars run to 24+ and keep growing; yearly bars stay
 *  legible out to decades. The middle calendar switches to month cells a little
 *  earlier (see MONTH_CALENDAR_MIN_DAYS) — bars tolerate more marks than a grid
 *  of cells does. */
const YEARLY_MIN_DAYS = 730;

export function overviewGranularity(range: Range): OverviewGranularity {
  const days = calendarDays(range);
  if (days <= 30) return "daily";
  if (days <= 90) return "weekly";
  if (days <= YEARLY_MIN_DAYS) return "monthly";
  return "yearly";
}

/** Range length at which the Calendar view drops from day cells to month cells.
 *  Above ~14 months day cells slice too thin to read; the Year preset (365d)
 *  stays on days, and the buffer keeps a range from flipping the day after. */
export const MONTH_CALENDAR_MIN_DAYS = 425;

export interface DailyActivitySummary {
  date: Date;
  key: string;
  trackedSeconds: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
  /** Seconds per category name, UNCATEGORIZED_LABEL for unmatched sessions. */
  categorySeconds: Map<string, number>;
  topApp: { process: string; seconds: number } | null;
}

export interface HourlyActivitySummary {
  hour: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
  categorySeconds: Map<string, number>;
}

/** Zero-filled activity-state totals for each visible local hour of a
 *  single-day range. The same configured window drives the Timeline above. */
export function hourlyActivitySummaries(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
  startHour: number,
  endHour: number,
): HourlyActivitySummary[] {
  const hours = Array.from({ length: endHour - startHour }, (_, index) => ({
    hour: startHour + index,
    productiveSeconds: 0,
    neutralSeconds: 0,
    unproductiveSeconds: 0,
    uncategorizedSeconds: 0,
    categorySeconds: new Map<string, number>(),
  }));
  const byHour = new Map(hours.map((hour) => [hour.hour, hour]));
  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;

  forEachClippedSession(sessions, startSec, endSec, (session) => {
    if (session.isAfk) return;
    const category = classifier(session);
    if (category?.isIgnored) return;
    let cursor = session.start;
    while (cursor < session.end) {
      const date = new Date(cursor * 1000);
      const nextHour = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours() + 1,
      ).getTime() / 1000;
      const chunkEnd = Math.min(session.end, nextHour > cursor ? nextHour : cursor + 3600);
      const bucket = byHour.get(date.getHours());
      if (bucket) {
        const seconds = chunkEnd - cursor;
        if (!category) bucket.uncategorizedSeconds += seconds;
        else {
          const kind = categoryKind(category);
          if (kind === "productive") bucket.productiveSeconds += seconds;
          else if (kind === "neutral") bucket.neutralSeconds += seconds;
          else bucket.unproductiveSeconds += seconds;
        }
        addCategorySeconds(bucket.categorySeconds, category?.name, seconds);
      }
      cursor = chunkEnd;
    }
  });

  return hours;
}

export interface RhythmCell {
  /** Local weekday, 0 = Sunday. */
  weekday: number;
  /** Local hour of day. */
  hour: number;
  trackedSeconds: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
  topApp: { process: string; seconds: number } | null;
}

export interface WeekdayRhythmSummary {
  /** Weekday-major, zero-filled cells for each visible local hour. */
  cells: RhythmCell[];
  /** Calendar days of each weekday (Sun..Sat) inside the range — the
   *  denominator for per-occurrence averages. */
  weekdayCounts: number[];
}

/** Non-AFK activity keyed by (weekday, visible local hour) for the rhythm
 *  heatmap. Totals here; callers divide by `weekdayCounts` so a range with
 *  five Mondays but four Sundays compares fairly. */
export function weekdayRhythmSummaries(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
  startHour: number,
  endHour: number,
): WeekdayRhythmSummary {
  const cells: (RhythmCell & { appSeconds: Map<string, number> })[] = [];
  const byKey = new Map<number, (typeof cells)[number]>();
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = startHour; hour < endHour; hour++) {
      const cell = {
        weekday,
        hour,
        trackedSeconds: 0,
        productiveSeconds: 0,
        neutralSeconds: 0,
        unproductiveSeconds: 0,
        uncategorizedSeconds: 0,
        topApp: null,
        appSeconds: new Map<string, number>(),
      };
      cells.push(cell);
      byKey.set(weekday * 24 + hour, cell);
    }
  }
  const weekdayCounts = Array(7).fill(0) as number[];
  for (const day of listDays(range)) weekdayCounts[day.getDay()] += 1;

  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;
  forEachClippedSession(sessions, startSec, endSec, (session) => {
    if (session.isAfk) return;
    const category = classifier(session);
    if (category?.isIgnored) return;
    let cursor = session.start;
    while (cursor < session.end) {
      const date = new Date(cursor * 1000);
      const nextHour = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours() + 1,
      ).getTime() / 1000;
      const chunkEnd = Math.min(session.end, nextHour > cursor ? nextHour : cursor + 3600);
      const cell = byKey.get(date.getDay() * 24 + date.getHours());
      if (cell) {
        const seconds = chunkEnd - cursor;
        cell.trackedSeconds += seconds;
        if (!category) cell.uncategorizedSeconds += seconds;
        else {
          const kind = categoryKind(category);
          if (kind === "productive") cell.productiveSeconds += seconds;
          else if (kind === "neutral") cell.neutralSeconds += seconds;
          else cell.unproductiveSeconds += seconds;
        }
        cell.appSeconds.set(session.process, (cell.appSeconds.get(session.process) ?? 0) + seconds);
      }
      cursor = chunkEnd;
    }
  });

  return {
    cells: cells.map(({ appSeconds, ...cell }) => {
      let topApp: RhythmCell["topApp"] = null;
      for (const [process, seconds] of appSeconds) {
        if (!topApp || seconds > topApp.seconds) topApp = { process, seconds };
      }
      return { ...cell, topApp };
    }),
    weekdayCounts,
  };
}

/** Zero-filled, non-AFK activity by local calendar day within `range`. */
export function dailyActivitySummaries(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
): DailyActivitySummary[] {
  const days = listDays(range);
  const byKey = new Map(
    days.map((date) => [
      dayKey(date),
      {
        date,
        key: dayKey(date),
        trackedSeconds: 0,
        productiveSeconds: 0,
        neutralSeconds: 0,
        unproductiveSeconds: 0,
        uncategorizedSeconds: 0,
        categorySeconds: new Map<string, number>(),
        topApp: null,
        appSeconds: new Map<string, number>(),
      },
    ]),
  );
  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;

  forEachClippedSession(sessions, startSec, endSec, (session) => {
    if (session.isAfk) return;
    const category = classifier(session);
    if (category?.isIgnored) return;
    forEachDayChunk(session.start, session.end, (chunk) => {
      const day = byKey.get(dayKey(chunk.dayStart));
      if (!day) return;
      const seconds = chunk.endSec - chunk.startSec;
      day.trackedSeconds += seconds;
      if (!category) day.uncategorizedSeconds += seconds;
      else {
        const kind = categoryKind(category);
        if (kind === "productive") day.productiveSeconds += seconds;
        else if (kind === "neutral") day.neutralSeconds += seconds;
        else day.unproductiveSeconds += seconds;
      }
      addCategorySeconds(day.categorySeconds, category?.name, seconds);
      day.appSeconds.set(session.process, (day.appSeconds.get(session.process) ?? 0) + seconds);
    });
  });

  return [...byKey.values()].map(({ appSeconds, ...day }) => {
    let topApp: DailyActivitySummary["topApp"] = null;
    for (const [process, seconds] of appSeconds) {
      if (!topApp || seconds > topApp.seconds) topApp = { process, seconds };
    }
    return { ...day, topApp };
  });
}

export interface MonthlyActivitySummary {
  year: number;
  /** Local month, 0 = January. */
  month: number;
  key: string;
  trackedSeconds: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
  categorySeconds: Map<string, number>;
  topApp: { process: string; seconds: number } | null;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Zero-filled, non-AFK activity by local calendar month within `range` — the
 *  long-range calendar's cells. Day chunks (from splitAtMidnights) each fall in
 *  exactly one month, so this needs no finer splitting. */
export function monthlyActivitySummaries(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
): MonthlyActivitySummary[] {
  const byKey = new Map<
    string,
    MonthlyActivitySummary & { appSeconds: Map<string, number> }
  >();
  const first = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
  for (let m = first; m < range.end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const key = monthKey(m.getFullYear(), m.getMonth());
    byKey.set(key, {
      year: m.getFullYear(),
      month: m.getMonth(),
      key,
      trackedSeconds: 0,
      productiveSeconds: 0,
      neutralSeconds: 0,
      unproductiveSeconds: 0,
      uncategorizedSeconds: 0,
      categorySeconds: new Map<string, number>(),
      topApp: null,
      appSeconds: new Map<string, number>(),
    });
  }

  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;
  forEachClippedSession(sessions, startSec, endSec, (session) => {
    if (session.isAfk) return;
    const category = classifier(session);
    if (category?.isIgnored) return;
    forEachDayChunk(session.start, session.end, (chunk) => {
      const month = byKey.get(monthKey(chunk.dayStart.getFullYear(), chunk.dayStart.getMonth()));
      if (!month) return;
      const seconds = chunk.endSec - chunk.startSec;
      month.trackedSeconds += seconds;
      if (!category) month.uncategorizedSeconds += seconds;
      else {
        const kind = categoryKind(category);
        if (kind === "productive") month.productiveSeconds += seconds;
        else if (kind === "neutral") month.neutralSeconds += seconds;
        else month.unproductiveSeconds += seconds;
      }
      addCategorySeconds(month.categorySeconds, category?.name, seconds);
      month.appSeconds.set(session.process, (month.appSeconds.get(session.process) ?? 0) + seconds);
    });
  });

  return [...byKey.values()].map(({ appSeconds, ...month }) => {
    let topApp: MonthlyActivitySummary["topApp"] = null;
    for (const [process, seconds] of appSeconds) {
      if (!topApp || seconds > topApp.seconds) topApp = { process, seconds };
    }
    return { ...month, topApp };
  });
}

export interface HoursBucket {
  key: string;
  /** Calendar-aligned start used for the x-axis label. */
  periodStart: Date;
  /** Selected-range portion represented by this bucket. */
  includedStart: Date;
  /** Exclusive selected-range end represented by this bucket. */
  includedEnd: Date;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
  categorySeconds: Map<string, number>;
}

type BucketGranularity = Exclude<OverviewGranularity, "daily">;

/** Calendar-aligned start of the period containing `date`. */
function periodStartOf(date: Date, granularity: BucketGranularity, weekStart: WeekStart): Date {
  if (granularity === "weekly") return startOfWeek(date, weekStart);
  if (granularity === "monthly") return new Date(date.getFullYear(), date.getMonth(), 1);
  return new Date(date.getFullYear(), 0, 1);
}

/** Start of the period after the one beginning at `periodStart`. */
function nextPeriodStart(periodStart: Date, granularity: BucketGranularity): Date {
  if (granularity === "weekly") return addDays(periodStart, 7);
  if (granularity === "monthly") {
    return new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);
  }
  return new Date(periodStart.getFullYear() + 1, 0, 1);
}

export function bucketActivityHours(
  days: DailyActivitySummary[],
  range: Range,
  granularity: BucketGranularity,
  weekStart: WeekStart,
): HoursBucket[] {
  const rangeStart = startOfDay(range.start);
  const firstPeriod = periodStartOf(rangeStart, granularity, weekStart);
  const buckets: HoursBucket[] = [];

  for (let periodStart = firstPeriod; periodStart < range.end; ) {
    const periodEnd = nextPeriodStart(periodStart, granularity);
    buckets.push({
      key: dayKey(periodStart),
      periodStart,
      includedStart: periodStart < rangeStart ? rangeStart : periodStart,
      includedEnd: periodEnd > range.end ? range.end : periodEnd,
      productiveSeconds: 0,
      neutralSeconds: 0,
      unproductiveSeconds: 0,
      uncategorizedSeconds: 0,
      categorySeconds: new Map<string, number>(),
    });
    periodStart = periodEnd;
  }

  let bucketIndex = 0;
  for (const day of days) {
    while (
      bucketIndex < buckets.length - 1 &&
      day.date >= buckets[bucketIndex].includedEnd
    ) {
      bucketIndex += 1;
    }
    const bucket = buckets[bucketIndex];
    if (!bucket || day.date < bucket.includedStart || day.date >= bucket.includedEnd) continue;
    bucket.productiveSeconds += day.productiveSeconds;
    bucket.neutralSeconds += day.neutralSeconds;
    bucket.unproductiveSeconds += day.unproductiveSeconds;
    bucket.uncategorizedSeconds += day.uncategorizedSeconds;
    for (const [name, seconds] of day.categorySeconds) {
      bucket.categorySeconds.set(name, (bucket.categorySeconds.get(name) ?? 0) + seconds);
    }
  }

  return buckets;
}

export function overviewHistoryStart(
  range: Range,
  granularity: OverviewGranularity,
  weekStart: WeekStart,
): Date {
  // Enough prior periods to seed the first visible rolling average.
  if (granularity === "daily") return addDays(range.start, -6);
  if (granularity === "weekly") return addDays(startOfWeek(range.start, weekStart), -21);
  if (granularity === "monthly") {
    return new Date(range.start.getFullYear(), range.start.getMonth() - 2, 1);
  }
  return new Date(range.start.getFullYear() - 2, 0, 1);
}

export function isCompleteHoursBucket(
  bucket: HoursBucket,
  granularity: BucketGranularity,
): boolean {
  const periodEnd = nextPeriodStart(bucket.periodStart, granularity);
  return (
    bucket.includedStart.getTime() === bucket.periodStart.getTime() &&
    bucket.includedEnd.getTime() === periodEnd.getTime()
  );
}
