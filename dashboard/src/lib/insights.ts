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
  addWebsiteSeconds,
  addTopAppSeconds,
  forEachDayChunk,
  goalPace,
  focusChain,
  type FocusChain,
  rankAppUsage,
  rankWebsiteUsage,
  topAppOf,
  withDeltas,
  type AppUsage,
  type AppUsageAccumulator,
  type AppDelta,
  type Kpis,
  type Session,
  type WebsiteDelta,
  type WebsiteUsage,
  type WebsiteUsageAccumulator,
} from "./metrics";
import type { BrowserDomainCoverage } from "./domainCoverage";
import { isUtilityName } from "./noise";
import {
  hourlyActivitySummaries,
  addProductivitySeconds,
  monthlyActivitySummaries,
  overviewGranularity,
  overviewHistoryStart,
  weekdayRhythmSummaries,
  MONTH_CALENDAR_MIN_DAYS,
  observationStateForPeriod,
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
  matchedPreviousRange,
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
  currentWebsiteRanked: WebsiteUsage[];
  previousWebsiteRanked: WebsiteUsage[];
  currentWebsiteDaily: Map<string, number[]>;
  previousWebsiteDaily: Map<string, number[]>;
  websiteCoverage: BrowserDomainCoverage;
  previousWebsiteCoverage: BrowserDomainCoverage;
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
  /** Hide utility-named rows from the app and website rankings. Mirrors
   *  the Activity Library's utilities switch; totals are never affected. */
  hideUtilityApps: boolean;
  dayStartHour: number;
  dayEndHour: number;
  labelMode: "weekday" | "date";
  /** Exact beginning of Time's observable history, not merely its calendar day. */
  firstObservedSec: number | null;
  /** Exact end of the current observation window for partial-period math. */
  analysisCutoffSec: number;
}

export interface InsightsModel {
  range: Range;
  previous: Range;
  granularity: OverviewGranularity;
  rangeDays: number;
  labelMode: "weekday" | "date";
  kpis: Kpis;
  pace: ReturnType<typeof goalPace>;
  apps: AppDelta[];
  websites: WebsiteDelta[];
  websiteCoverage: BrowserDomainCoverage;
  previousWebsiteCoverage: BrowserDomainCoverage;
  appComparisonAvailable: boolean;
  websiteComparisonAvailable: boolean;
  hiddenAppCount: number;
  hiddenWebsiteCount: number;
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
  /** Zero means no detected website; every dictionary index is offset by one. */
  domainIndices: Uint32Array;
  categoryIndices: Int32Array;
  isAfk: Uint8Array;
  processes: string[];
  domains: string[];
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

function makeDays(
  range: Range,
  focusChainMaxGapSeconds: number,
  firstObservedSec: number | null,
  analysisCutoffSec: number,
): Map<string, MutableDay> {
  return new Map(
    listDays(range).map((date) => {
      const key = dayKey(date);
      return [
        key,
        {
          date,
          key,
          observation: observationStateForPeriod(
            date,
            new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1),
            date,
            new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1),
            firstObservedSec,
            analysisCutoffSec,
          ),
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
 * clipped, classified, and split the same rows independently for KPIs, ranked
 * identities, daily deltas, the calendar, and the hours chart.
 */
export function aggregateInsightsSessions(
  sessions: Session[],
  range: Range,
  classifier: Classifier,
  focusChainMaxGapSeconds: number,
  weekStart: WeekStart,
  aliases?: Record<string, string>,
  browserProcesses: ReadonlySet<string> = new Set(),
  firstObservedSec: number | null = range.start.getTime() / 1000,
  analysisCutoffSec: number = range.end.getTime() / 1000,
): InsightsAggregation {
  const previous = matchedPreviousRange(range, new Date(analysisCutoffSec * 1000));
  const granularity = overviewGranularity(range);
  const historyRange = {
    start: overviewHistoryStart(range, granularity, weekStart),
    end: range.end,
  };
  const rangeStart = range.start.getTime() / 1000;
  const rangeEnd = Math.min(range.end.getTime() / 1000, analysisCutoffSec);
  const previousStart = previous.start.getTime() / 1000;
  const previousEnd = previous.end.getTime() / 1000;
  const historyStart = historyRange.start.getTime() / 1000;
  const historyDays = makeDays(
    historyRange,
    focusChainMaxGapSeconds,
    firstObservedSec,
    analysisCutoffSec,
  );
  const currentDayIndex = new Map(listDays(range).map((date, index) => [dayKey(date), index]));
  const previousDayIndex = new Map(
    listDays(previous).map((date, index) => [dayKey(date), index]),
  );
  const currentDaily = new Map<string, number[]>();
  const previousDaily = new Map<string, number[]>();
  const currentApps = new Map<string, AppUsageAccumulator>();
  const previousApps = new Map<string, AppUsageAccumulator>();
  const currentWebsites = new Map<string, WebsiteUsageAccumulator>();
  const previousWebsites = new Map<string, WebsiteUsageAccumulator>();
  const currentWebsiteDaily = new Map<string, number[]>();
  const previousWebsiteDaily = new Map<string, number[]>();
  const activeDayKeys = new Set<string>();
  const current: Session[] = [];
  let totalSec = 0;
  let prodSec = 0;
  let uncategorizedSec = 0;
  let browserSeconds = 0;
  let missingDomainSeconds = 0;
  let previousBrowserSeconds = 0;
  let previousMissingDomainSeconds = 0;
  const rangeChain = focusChain(focusChainMaxGapSeconds);

  // Keyed by ranked row, not by raw session: `withDeltas` looks these series up
  // by the row's key, and a miss would read as a quiet "no time last period".
  const usageDailyArray = (into: Map<string, number[]>, key: string, length: number) => {
    let values = into.get(key);
    if (!values) {
      values = Array(length).fill(0);
      into.set(key, values);
    }
    return values;
  };
  const appDailyArray = (into: Map<string, number[]>, process: string, length: number) =>
    usageDailyArray(into, appGroupKey(process, aliases), length);

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
        if (browserProcesses.has(inCurrent.process.toLowerCase())) {
          browserSeconds += seconds;
          if (inCurrent.domain) {
            addWebsiteSeconds(currentWebsites, inCurrent.domain, aliases, category, seconds);
          } else {
            missingDomainSeconds += seconds;
          }
        }
        if (category?.isProductive) prodSec += seconds;
        if (!category) uncategorizedSec += seconds;
        rangeChain.add(inCurrent.start, inCurrent.end, seconds, category);
      }
    }

    if (inPrevious && !inPrevious.isAfk) {
      const seconds = inPrevious.end - inPrevious.start;
      addAppSeconds(previousApps, inPrevious.process, aliases, category, seconds);
      const values = appDailyArray(previousDaily, inPrevious.process, previousDayIndex.size);
      const previousIsBrowser = browserProcesses.has(inPrevious.process.toLowerCase());
      if (previousIsBrowser) {
        previousBrowserSeconds += seconds;
        if (!inPrevious.domain) previousMissingDomainSeconds += seconds;
      }
      const previousWebsiteKey = previousIsBrowser
        ? inPrevious.domain?.toLowerCase() ?? null
        : null;
      if (previousWebsiteKey) {
        addWebsiteSeconds(previousWebsites, previousWebsiteKey, aliases, category, seconds);
      }
      const websiteValues = previousWebsiteKey
        ? usageDailyArray(previousWebsiteDaily, previousWebsiteKey, previousDayIndex.size)
        : null;
      forEachDayChunk(inPrevious.start, inPrevious.end, (chunk) => {
        const index = previousDayIndex.get(dayKey(chunk.dayStart));
        if (index !== undefined) {
          const seconds = chunk.endSec - chunk.startSec;
          values[index] += seconds;
          if (websiteValues) websiteValues[index] += seconds;
        }
      });
    }

    if (inHistory) {
      const currentValues = inCurrent && !inHistory.isAfk
        ? appDailyArray(currentDaily, inCurrent.process, currentDayIndex.size)
        : null;
      const currentWebsiteKey = inCurrent
        && !inHistory.isAfk
        && browserProcesses.has(inCurrent.process.toLowerCase())
        ? inCurrent.domain?.toLowerCase() ?? null
        : null;
      const currentWebsiteValues = currentWebsiteKey
        ? usageDailyArray(currentWebsiteDaily, currentWebsiteKey, currentDayIndex.size)
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
              if (currentWebsiteValues) currentWebsiteValues[index] += seconds;
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
      uncategorizedSec,
    },
    currentRanked: rankAppUsage(currentApps),
    previousRanked: rankAppUsage(previousApps),
    currentDaily,
    previousDaily,
    currentWebsiteRanked: rankWebsiteUsage(currentWebsites),
    previousWebsiteRanked: rankWebsiteUsage(previousWebsites),
    currentWebsiteDaily,
    previousWebsiteDaily,
    websiteCoverage: {
      totalSeconds: browserSeconds,
      missingSeconds: missingDomainSeconds,
      missingFraction: browserSeconds === 0 ? 0 : missingDomainSeconds / browserSeconds,
    },
    previousWebsiteCoverage: {
      totalSeconds: previousBrowserSeconds,
      missingSeconds: previousMissingDomainSeconds,
      missingFraction:
        previousBrowserSeconds === 0 ? 0 : previousMissingDomainSeconds / previousBrowserSeconds,
    },
    historyDays: finalizeDays(historyDays),
    activeDays: activeDayKeys.size,
  };
}

export function websiteComparisonIsAvailable(
  observationComparisonAvailable: boolean,
  current: BrowserDomainCoverage,
  previous: BrowserDomainCoverage,
): boolean {
  if (!observationComparisonAvailable) return false;
  const currentDetected = 1 - current.missingFraction;
  const previousDetected = 1 - previous.missingFraction;
  return currentDetected >= 0.8
    && previousDetected >= 0.8
    && Math.abs(currentDetected - previousDetected) <= 0.1 + Number.EPSILON;
}

function buildInsightsModelWithClassifier(
  request: InsightsRequest,
  classifier: Classifier,
): InsightsModel {
  const previous = matchedPreviousRange(
    request.range,
    new Date(request.analysisCutoffSec * 1000),
  );
  const granularity = overviewGranularity(request.range);
  const rangeDays = calendarDays(request.range);
  const aggregation = aggregateInsightsSessions(
    request.sessions,
    request.range,
    classifier,
    request.focusChainMaxGapSeconds,
    request.weekStart,
    request.aliases,
    new Set(request.browserProcesses),
    request.firstObservedSec,
    request.analysisCutoffSec,
  );
  const appComparisonAvailable =
    request.firstObservedSec !== null
    && previous.end > previous.start
    && previous.start.getTime() / 1000 >= request.firstObservedSec;
  const websiteComparisonAvailable = websiteComparisonIsAvailable(
    appComparisonAvailable,
    aggregation.websiteCoverage,
    aggregation.previousWebsiteCoverage,
  );
  // The filter is a rate, not a total: a flat "hide under 2 minutes" bar is
  // most of a day's use of a rare app on Today and invisible on Year, so the
  // same list would churn purely from changing the range. Scaling by days that
  // recorded something — not calendar days — keeps holidays and pre-install
  // stretches inside a long range from inflating the bar.
  //
  // One bar for both rankings. It was app-only when Insights had no website
  // ranking to apply it to, and the reasoning for keeping it that way once the
  // ranking arrived — that website traffic is more fragmented, so the same rate
  // erases more of it — describes what the reader is asking for rather than an
  // argument against it: the panel offers one switch between two lists, and a
  // minimum that silently stops applying when that switch moves is the harder
  // behavior to predict. Both counts are reported, so a bar set too high for
  // fragmented traffic says so in the footer instead of just emptying the list.
  const minThresholdSeconds =
    request.minAppSecondsPerDay * Math.max(aggregation.activeDays, 1);
  // Two independent reasons a row can leave the list, kept apart because only
  // the first one is reported. The footer names a duration preference, so
  // folding utilities into its count would have it explain a row's absence with
  // a threshold that row never met.
  const aboveThreshold = aggregation.currentRanked.filter(
    (app) => app.seconds >= minThresholdSeconds,
  );
  // Utility rows drop out of the ranking but not out of any total: the KPIs and
  // the hourly chart above still count every second the plumbing spent in the
  // foreground. A row the reader has classified stays, because putting an
  // entity in a category is an explicit statement that it matters — the same
  // precedence `classifyNoise` gives the catalog.
  const eligibleApps = aboveThreshold.filter(
    (app) =>
      !(
        request.hideUtilityApps
        && app.category === null
        && isUtilityName({ kind: "app", key: app.key, sourceProcesses: app.processes })
      ),
  );
  const apps = withDeltas(eligibleApps.slice(0, 20), aggregation.previousRanked, {
    currentDaily: aggregation.currentDaily,
    previousDaily: aggregation.previousDaily,
  });
  // Same two-step as apps, and same order, so the reported count means the same
  // thing in both lists: the threshold first and countable, then the utility
  // test, which for a website catches a local file the browser rendered — no
  // more a destination than msiexec is an app.
  const websitesAboveThreshold = aggregation.currentWebsiteRanked.filter(
    (site) => site.seconds >= minThresholdSeconds,
  );
  const eligibleWebsites = websitesAboveThreshold.filter(
    (site) =>
      !(
        request.hideUtilityApps
        && site.category === null
        && isUtilityName({ kind: "website", key: site.key, sourceProcesses: [] })
      ),
  );
  const websites = withDeltas(
    eligibleWebsites.slice(0, 20),
    aggregation.previousWebsiteRanked,
    {
      currentDaily: aggregation.currentWebsiteDaily,
      previousDaily: aggregation.previousWebsiteDaily,
    },
  );
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
          request.firstObservedSec,
          request.analysisCutoffSec,
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
          request.firstObservedSec,
          request.analysisCutoffSec,
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
    websites,
    websiteCoverage: aggregation.websiteCoverage,
    previousWebsiteCoverage: aggregation.previousWebsiteCoverage,
    appComparisonAvailable,
    websiteComparisonAvailable,
    hiddenAppCount: aggregation.currentRanked.length - aboveThreshold.length,
    hiddenWebsiteCount:
      aggregation.currentWebsiteRanked.length - websitesAboveThreshold.length,
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

/** Classify once on the renderer, then transfer numeric columns plus compact
 * process/domain dictionaries. Raw titles remain unnecessary, and repeating a
 * domain index per row is far cheaper than structured-cloning every string. */
interface InsightsPackingState {
  request: InsightsRequest;
  classifier: Classifier;
  categoryIndex: Map<number, number>;
  processIndex: Map<string, number>;
  domainIndex: Map<string, number>;
  starts: Float64Array;
  ends: Float64Array;
  processIndices: Uint32Array;
  domainIndices: Uint32Array;
  categoryIndices: Int32Array;
  isAfk: Uint8Array;
  processes: string[];
  domains: string[];
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
    domainIndex: new Map(),
    starts: new Float64Array(count),
    ends: new Float64Array(count),
    processIndices: new Uint32Array(count),
    domainIndices: new Uint32Array(count),
    categoryIndices: new Int32Array(count),
    isAfk: new Uint8Array(count),
    processes: [],
    domains: [],
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
    if (session.domain) {
      let domain = state.domainIndex.get(session.domain);
      if (domain === undefined) {
        domain = state.domains.length;
        state.domains.push(session.domain);
        state.domainIndex.set(session.domain, domain);
      }
      state.domainIndices[index] = domain + 1;
    }
  }
}

function finishPacking(state: InsightsPackingState): PackedInsightsRequest {
  const { sessions: _sessions, ...baseRequest } = state.request;
  return {
    request: baseRequest,
    starts: state.starts,
    ends: state.ends,
    processIndices: state.processIndices,
    domainIndices: state.domainIndices,
    categoryIndices: state.categoryIndices,
    isAfk: state.isAfk,
    processes: state.processes,
    domains: state.domains,
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
    packed.domainIndices.length !== count ||
    packed.categoryIndices.length !== count ||
    packed.isAfk.length !== count
  ) {
    throw new Error("Packed Insights columns have mismatched lengths");
  }
  const sessions: Session[] = Array.from({ length: count }, (_, index) => {
    const domainIndex = packed.domainIndices[index];
    return {
      id: index,
      start: packed.starts[index],
      end: packed.ends[index],
      process: packed.processes[packed.processIndices[index]] ?? "",
      title: "",
      domain: domainIndex === 0 ? null : packed.domains[domainIndex - 1] ?? null,
      isAfk: packed.isAfk[index] !== 0,
    };
  });
  const classifier: Classifier = (value) => {
    const index = (value as Session).id;
    const categoryIndex = packed.categoryIndices[index];
    return categoryIndex >= 0 ? (packed.request.categories[categoryIndex] ?? null) : null;
  };
  return buildInsightsModelWithClassifier({ ...packed.request, sessions }, classifier);
}
