import {
  buildClassifier,
  categoryKind,
  memoizeClassifierById,
  type Category,
  type Classifier,
  type Rule,
} from "./classify";
import { appGroupKey } from "./format";
import {
  addAppSeconds,
  addTopAppSeconds,
  forEachDayChunk,
  goalPace,
  focusChain,
  type FocusChain,
  rankAppUsage,
  topAppOf,
  withDeltas,
  type AppUsage,
  type AppUsageAccumulator,
  type Kpis,
  type Session,
} from "./metrics";
import {
  hourlyActivitySummaries,
  addProductivitySeconds,
  monthlyActivitySummaries,
  overviewGranularity,
  overviewHistoryStart,
  weekdayRhythmSummaries,
  MONTH_CALENDAR_MIN_DAYS,
  UNCATEGORIZED_LABEL,
  type DailyActivitySummary,
  type HourlyActivitySummary,
  type MonthlyActivitySummary,
  type OverviewGranularity,
  type WeekdayRhythmSummary,
} from "./overview";
import {
  calendarDays,
  dayKey,
  listDays,
  previousRange,
  type Range,
  type WeekStart,
} from "./time";

interface MutableDay extends Omit<DailyActivitySummary, "longestFocusSeconds"> {
  appSeconds: Map<string, { name: string; seconds: number }>;
  chain: FocusChain;
}

interface InsightsAggregation {
  current: Session[];
  kpis: Kpis;
  currentRanked: AppUsage[];
  previousRanked: AppUsage[];
  currentDaily: Map<string, number[]>;
  previousDaily: Map<string, number[]>;
  historyDays: DailyActivitySummary[];
  /** Days in range that recorded any non-AFK activity. */
  activeDays: number;
}

export interface InsightsRequest {
  sessions: Session[];
  range: Range;
  categories: Category[];
  rules: Rule[];
  browserProcesses: string[];
  weekStart: WeekStart;
  weeklyGoalHours: number;
  minAppSecondsPerDay: number;
  /** Process display names. Rows group by these, so a rename regroups the list
   *  — `insightsRequestKey` has to include them or the change won't be seen. */
  aliases: Record<string, string>;
  focusChainMaxGapSeconds: number;
  dayStartHour: number;
  dayEndHour: number;
  labelMode: "weekday" | "date";
}

export interface InsightsModel {
  range: Range;
  previous: Range;
  granularity: OverviewGranularity;
  rangeDays: number;
  labelMode: "weekday" | "date";
  kpis: Kpis;
  pace: ReturnType<typeof goalPace>;
  apps: ReturnType<typeof withDeltas>;
  hiddenAppCount: number;
  historyDays: DailyActivitySummary[];
  timelineSessions: Session[] | null;
  rhythm: WeekdayRhythmSummary | null;
  monthly: MonthlyActivitySummary[] | null;
  hourly: HourlyActivitySummary[] | null;
}

export interface PackedInsightsRequest {
  request: Omit<InsightsRequest, "sessions">;
  starts: Float64Array;
  ends: Float64Array;
  processIndices: Uint32Array;
  categoryIndices: Int32Array;
  isAfk: Uint8Array;
  processes: string[];
}

export type InsightsWorkerRequest =
  | { id: number; request: InsightsRequest }
  | { id: number; packed: PackedInsightsRequest };

export type InsightsWorkerResponse =
  | { id: number; model: InsightsModel }
  | { id: number; error: string };

function clipped(session: Session, startSec: number, endSec: number): Session | null {
  const start = Math.max(session.start, startSec);
  const end = Math.min(session.end, endSec);
  if (end <= start) return null;
  return start === session.start && end === session.end
    ? session
    : { ...session, start, end };
}

function makeDays(range: Range, focusChainMaxGapSeconds: number): Map<string, MutableDay> {
  return new Map(
    listDays(range).map((date) => {
      const key = dayKey(date);
      return [
        key,
        {
          date,
          key,
          trackedSeconds: 0,
          productiveSeconds: 0,
          neutralSeconds: 0,
          unproductiveSeconds: 0,
          uncategorizedSeconds: 0,
          categorySeconds: new Map<string, number>(),
          topApp: null,
          appSeconds: new Map<string, { name: string; seconds: number }>(),
          chain: focusChain(focusChainMaxGapSeconds),
        },
      ];
    }),
  );
}

function addDaySeconds(
  day: MutableDay | undefined,
  session: Session,
  category: Category | null,
  seconds: number,
  aliases: Record<string, string> | undefined,
): void {
  if (!day || seconds <= 0) return;
  day.trackedSeconds += seconds;
  if (!category) day.uncategorizedSeconds += seconds;
  else {
    const kind = categoryKind(category);
    addProductivitySeconds(day, kind, seconds);
  }
  const categoryName = category?.name ?? UNCATEGORIZED_LABEL;
  day.categorySeconds.set(
    categoryName,
    (day.categorySeconds.get(categoryName) ?? 0) + seconds,
  );
  addTopAppSeconds(day.appSeconds, session.process, aliases, seconds);
}

function finalizeDays(days: Map<string, MutableDay>): DailyActivitySummary[] {
  return [...days.values()].map(({ appSeconds, chain, ...day }) => ({
    ...day,
    longestFocusSeconds: chain.longestSeconds,
    topApp: topAppOf(appSeconds),
  }));
}

function orderedSessions(sessions: Session[]): Session[] {
  for (let index = 1; index < sessions.length; index++) {
    if (sessions[index - 1].start > sessions[index].start) {
      return [...sessions].sort((left, right) => left.start - right.start || left.id - right.id);
    }
  }
  return sessions;
}

/**
 * Build every shared Insights input in one ordered pass. The old path filtered,
 * clipped, classified, and split the same rows independently for KPIs, apps,
 * daily deltas, the calendar, and the hours chart.
 */
export function aggregateInsightsSessions(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
  focusChainMaxGapSeconds: number,
  weekStart: WeekStart,
  aliases?: Record<string, string>,
): InsightsAggregation {
  const previous = previousRange(range);
  const granularity = overviewGranularity(range);
  const historyRange = {
    start: overviewHistoryStart(range, granularity, weekStart),
    end: range.end,
  };
  const rangeStart = range.start.getTime() / 1000;
  const rangeEnd = range.end.getTime() / 1000;
  const previousStart = previous.start.getTime() / 1000;
  const previousEnd = previous.end.getTime() / 1000;
  const historyStart = historyRange.start.getTime() / 1000;
  const historyDays = makeDays(historyRange, focusChainMaxGapSeconds);
  const currentDayIndex = new Map(listDays(range).map((date, index) => [dayKey(date), index]));
  const previousDayIndex = new Map(
    listDays(previous).map((date, index) => [dayKey(date), index]),
  );
  const currentDaily = new Map<string, number[]>();
  const previousDaily = new Map<string, number[]>();
  const currentApps = new Map<string, AppUsageAccumulator>();
  const previousApps = new Map<string, AppUsageAccumulator>();
  const activeDayKeys = new Set<string>();
  const current: Session[] = [];
  let totalSec = 0;
  let prodSec = 0;
  const rangeChain = focusChain(focusChainMaxGapSeconds);

  // Keyed by app row, not by process: `withDeltas` looks these series up by the
  // row's key, and a miss would read as a quiet "no time last period".
  const dailyArray = (into: Map<string, number[]>, process: string, length: number) => {
    const key = appGroupKey(process, aliases);
    let values = into.get(key);
    if (!values) {
      values = Array(length).fill(0);
      into.set(key, values);
    }
    return values;
  };

  for (const source of orderedSessions(sessions)) {
    const category = classifier(source);
    if (category?.isIgnored) continue;
    const inCurrent = clipped(source, rangeStart, rangeEnd);
    const inPrevious = clipped(source, previousStart, previousEnd);
    const inHistory = clipped(source, historyStart, rangeEnd);

    if (inCurrent) {
      current.push(inCurrent);
      if (inCurrent.isAfk) {
        rangeChain.breakChain();
      } else {
        const seconds = inCurrent.end - inCurrent.start;
        totalSec += seconds;
        addAppSeconds(currentApps, inCurrent.process, aliases, category, seconds);
        if (category?.isProductive) prodSec += seconds;
        rangeChain.add(inCurrent.start, inCurrent.end, seconds, category);
      }
    }

    if (inPrevious && !inPrevious.isAfk) {
      const seconds = inPrevious.end - inPrevious.start;
      addAppSeconds(previousApps, inPrevious.process, aliases, category, seconds);
      const values = dailyArray(previousDaily, inPrevious.process, previousDayIndex.size);
      forEachDayChunk(inPrevious.start, inPrevious.end, (chunk) => {
        const index = previousDayIndex.get(dayKey(chunk.dayStart));
        if (index !== undefined) values[index] += chunk.endSec - chunk.startSec;
      });
    }

    if (inHistory) {
      const currentValues = inCurrent && !inHistory.isAfk
        ? dailyArray(currentDaily, inCurrent.process, currentDayIndex.size)
        : null;
      forEachDayChunk(inHistory.start, inHistory.end, (chunk) => {
        const key = dayKey(chunk.dayStart);
        const day = historyDays.get(key);
        if (inHistory.isAfk) {
          day?.chain.breakChain();
          return;
        }
        const seconds = chunk.endSec - chunk.startSec;
        addDaySeconds(day, inHistory, category, seconds, aliases);
        day?.chain.add(chunk.startSec, chunk.endSec, seconds, category);
        if (inCurrent && currentValues) {
          const overlapStart = Math.max(chunk.startSec, inCurrent.start);
          const overlapEnd = Math.min(chunk.endSec, inCurrent.end);
          const seconds = overlapEnd - overlapStart;
          if (seconds > 0) {
            const index = currentDayIndex.get(key);
            if (index !== undefined) {
              currentValues[index] += seconds;
              activeDayKeys.add(key);
            }
          }
        }
      });
    }
  }

  return {
    current,
    kpis: {
      totalSec,
      prodSec,
      prodFraction: totalSec > 0 ? prodSec / totalSec : 0,
      longestFocusSec: rangeChain.longestSeconds,
    },
    currentRanked: rankAppUsage(currentApps),
    previousRanked: rankAppUsage(previousApps),
    currentDaily,
    previousDaily,
    historyDays: finalizeDays(historyDays),
    activeDays: activeDayKeys.size,
  };
}

function buildInsightsModelWithClassifier(
  request: InsightsRequest,
  classifier: Classifier,
): InsightsModel {
  const previous = previousRange(request.range);
  const granularity = overviewGranularity(request.range);
  const rangeDays = calendarDays(request.range);
  const aggregation = aggregateInsightsSessions(
    request.sessions,
    request.range,
    classifier,
    request.focusChainMaxGapSeconds,
    request.weekStart,
    request.aliases,
  );
  // The filter is a rate, not a total: a flat "hide under 2 minutes" bar is
  // most of a day's use of a rare app on Today and invisible on Year, so the
  // same list would churn purely from changing the range. Scaling by days that
  // recorded something — not calendar days — keeps holidays and pre-install
  // stretches inside a long range from inflating the bar.
  const minAppThresholdSeconds =
    request.minAppSecondsPerDay * Math.max(aggregation.activeDays, 1);
  const eligibleApps = aggregation.currentRanked.filter(
    (app) => app.seconds >= minAppThresholdSeconds,
  );
  const apps = withDeltas(eligibleApps.slice(0, 20), aggregation.previousRanked, {
    currentDaily: aggregation.currentDaily,
    previousDaily: aggregation.previousDaily,
  });
  const timelineSessions = rangeDays <= 14 ? aggregation.current : null;
  const rhythm =
    rangeDays > 14
      ? weekdayRhythmSummaries(
          aggregation.current,
          request.range,
          classifier,
          request.dayStartHour,
          request.dayEndHour,
          request.aliases,
        )
      : null;
  const monthly =
    rangeDays >= MONTH_CALENDAR_MIN_DAYS
      ? monthlyActivitySummaries(
          aggregation.current,
          request.range,
          classifier,
          request.focusChainMaxGapSeconds,
          request.aliases,
        )
      : null;
  const hourly =
    rangeDays === 1
      ? hourlyActivitySummaries(
          aggregation.current,
          request.range,
          classifier,
          request.dayStartHour,
          request.dayEndHour,
        )
      : null;

  return {
    range: request.range,
    previous,
    granularity,
    rangeDays,
    labelMode: request.labelMode,
    kpis: aggregation.kpis,
    pace: goalPace(aggregation.kpis.prodSec, request.range, request.weeklyGoalHours),
    apps,
    hiddenAppCount: aggregation.currentRanked.length - eligibleApps.length,
    historyDays: aggregation.historyDays,
    timelineSessions,
    rhythm,
    monthly,
    hourly,
  };
}

export function buildInsightsModel(request: InsightsRequest): InsightsModel {
  const classifier = memoizeClassifierById(
    buildClassifier(request.categories, request.rules, new Set(request.browserProcesses)),
  );
  return buildInsightsModelWithClassifier(request, classifier);
}

/** Classify once on the renderer, then transfer only numeric columns and a
 * process dictionary. Long-range charts never need raw titles/domains after
 * classification; avoiding their structured clone cuts the hand-off sharply. */
interface InsightsPackingState {
  request: InsightsRequest;
  classifier: Classifier;
  categoryIndex: Map<number, number>;
  processIndex: Map<string, number>;
  starts: Float64Array;
  ends: Float64Array;
  processIndices: Uint32Array;
  categoryIndices: Int32Array;
  isAfk: Uint8Array;
  processes: string[];
}

function createPackingState(request: InsightsRequest): InsightsPackingState {
  const count = request.sessions.length;
  return {
    request,
    classifier: buildClassifier(
      request.categories,
      request.rules,
      new Set(request.browserProcesses),
    ),
    categoryIndex: new Map(request.categories.map((category, index) => [category.id, index])),
    processIndex: new Map(),
    starts: new Float64Array(count),
    ends: new Float64Array(count),
    processIndices: new Uint32Array(count),
    categoryIndices: new Int32Array(count),
    isAfk: new Uint8Array(count),
    processes: [],
  };
}

function packRows(state: InsightsPackingState, start: number, end: number): void {
  for (let index = start; index < end; index++) {
    const session = state.request.sessions[index];
    state.starts[index] = session.start;
    state.ends[index] = session.end;
    state.isAfk[index] = session.isAfk ? 1 : 0;
    const category = state.classifier(session);
    state.categoryIndices[index] = category
      ? (state.categoryIndex.get(category.id) ?? -1)
      : -1;
    let process = state.processIndex.get(session.process);
    if (process === undefined) {
      process = state.processes.length;
      state.processes.push(session.process);
      state.processIndex.set(session.process, process);
    }
    state.processIndices[index] = process;
  }
}

function finishPacking(state: InsightsPackingState): PackedInsightsRequest {
  const { sessions: _sessions, ...baseRequest } = state.request;
  return {
    request: baseRequest,
    starts: state.starts,
    ends: state.ends,
    processIndices: state.processIndices,
    categoryIndices: state.categoryIndices,
    isAfk: state.isAfk,
    processes: state.processes,
  };
}

export function packInsightsRequest(request: InsightsRequest): PackedInsightsRequest {
  const state = createPackingState(request);
  packRows(state, 0, request.sessions.length);
  return finishPacking(state);
}

export async function packInsightsRequestInChunks(
  request: InsightsRequest,
  yieldControl: () => Promise<void>,
  chunkSize = 20_000,
): Promise<PackedInsightsRequest> {
  const state = createPackingState(request);
  for (let start = 0; start < request.sessions.length; start += chunkSize) {
    packRows(state, start, Math.min(start + chunkSize, request.sessions.length));
    if (start + chunkSize < request.sessions.length) await yieldControl();
  }
  return finishPacking(state);
}

export function buildInsightsModelFromPacked(packed: PackedInsightsRequest): InsightsModel {
  const count = packed.starts.length;
  if (
    packed.ends.length !== count ||
    packed.processIndices.length !== count ||
    packed.categoryIndices.length !== count ||
    packed.isAfk.length !== count
  ) {
    throw new Error("Packed Insights columns have mismatched lengths");
  }
  const sessions: Session[] = Array.from({ length: count }, (_, index) => ({
    id: index,
    start: packed.starts[index],
    end: packed.ends[index],
    process: packed.processes[packed.processIndices[index]] ?? "",
    title: "",
    domain: null,
    isAfk: packed.isAfk[index] !== 0,
  }));
  const classifier: Classifier = (value) => {
    const index = (value as Session).id;
    const categoryIndex = packed.categoryIndices[index];
    return categoryIndex >= 0 ? (packed.request.categories[categoryIndex] ?? null) : null;
  };
  return buildInsightsModelWithClassifier({ ...packed.request, sessions }, classifier);
}
