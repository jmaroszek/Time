import { categoryKind, type Classifier } from "./classify";
import { clipSessions, splitAtMidnights, type Session } from "./metrics";
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

export type OverviewGranularity = "daily" | "weekly" | "monthly";

export function overviewGranularity(range: Range): OverviewGranularity {
  const days = calendarDays(range);
  if (days <= 30) return "daily";
  if (days <= 90) return "weekly";
  return "monthly";
}

export interface DailyActivitySummary {
  date: Date;
  key: string;
  trackedSeconds: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
  topApp: { process: string; seconds: number } | null;
}

export interface HourlyActivitySummary {
  hour: number;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  uncategorizedSeconds: number;
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
  }));
  const byHour = new Map(hours.map((hour) => [hour.hour, hour]));
  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;

  for (const session of clipSessions(sessions, startSec, endSec)) {
    if (session.isAfk) continue;
    const category = classifier(session);
    if (category?.isIgnored) continue;
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
      }
      cursor = chunkEnd;
    }
  }

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
  for (const session of clipSessions(sessions, startSec, endSec)) {
    if (session.isAfk) continue;
    const category = classifier(session);
    if (category?.isIgnored) continue;
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
  }

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
        topApp: null,
        appSeconds: new Map<string, number>(),
      },
    ]),
  );
  const startSec = range.start.getTime() / 1000;
  const endSec = range.end.getTime() / 1000;

  for (const session of clipSessions(sessions, startSec, endSec)) {
    if (session.isAfk) continue;
    const category = classifier(session);
    if (category?.isIgnored) continue;
    for (const chunk of splitAtMidnights(session.start, session.end)) {
      const day = byKey.get(dayKey(chunk.dayStart));
      if (!day) continue;
      const seconds = chunk.endSec - chunk.startSec;
      day.trackedSeconds += seconds;
      if (!category) day.uncategorizedSeconds += seconds;
      else {
        const kind = categoryKind(category);
        if (kind === "productive") day.productiveSeconds += seconds;
        else if (kind === "neutral") day.neutralSeconds += seconds;
        else day.unproductiveSeconds += seconds;
      }
      day.appSeconds.set(session.process, (day.appSeconds.get(session.process) ?? 0) + seconds);
    }
  }

  return [...byKey.values()].map(({ appSeconds, ...day }) => {
    let topApp: DailyActivitySummary["topApp"] = null;
    for (const [process, seconds] of appSeconds) {
      if (!topApp || seconds > topApp.seconds) topApp = { process, seconds };
    }
    return { ...day, topApp };
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
}

export function bucketActivityHours(
  days: DailyActivitySummary[],
  range: Range,
  granularity: Exclude<OverviewGranularity, "daily">,
  weekStart: WeekStart,
): HoursBucket[] {
  const rangeStart = startOfDay(range.start);
  const firstPeriod =
    granularity === "weekly"
      ? startOfWeek(rangeStart, weekStart)
      : new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  const buckets: HoursBucket[] = [];

  for (let periodStart = firstPeriod; periodStart < range.end; ) {
    const periodEnd =
      granularity === "weekly"
        ? addDays(periodStart, 7)
        : new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 1);
    buckets.push({
      key: dayKey(periodStart),
      periodStart,
      includedStart: periodStart < rangeStart ? rangeStart : periodStart,
      includedEnd: periodEnd > range.end ? range.end : periodEnd,
      productiveSeconds: 0,
      neutralSeconds: 0,
      unproductiveSeconds: 0,
      uncategorizedSeconds: 0,
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
  }

  return buckets;
}

export function overviewHistoryStart(
  range: Range,
  granularity: OverviewGranularity,
  weekStart: WeekStart,
): Date {
  if (granularity === "daily") return addDays(range.start, -6);
  if (granularity === "weekly") return addDays(startOfWeek(range.start, weekStart), -21);
  return new Date(range.start.getFullYear(), range.start.getMonth() - 2, 1);
}

export function isCompleteHoursBucket(
  bucket: HoursBucket,
  granularity: Exclude<OverviewGranularity, "daily">,
): boolean {
  const periodEnd = granularity === "weekly"
    ? addDays(bucket.periodStart, 7)
    : new Date(bucket.periodStart.getFullYear(), bucket.periodStart.getMonth() + 1, 1);
  return (
    bucket.includedStart.getTime() === bucket.periodStart.getTime() &&
    bucket.includedEnd.getTime() === periodEnd.getTime()
  );
}
