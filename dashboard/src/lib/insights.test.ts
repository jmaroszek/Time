import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";
import {
  clipSessions,
  computeKpis,
  dailySecondsByApp,
  topApps,
  type Session,
} from "./metrics";
import {
  aggregateInsightsSessions,
  buildInsightsModel,
  buildInsightsModelFromPacked,
  packInsightsRequest,
  packInsightsRequestInChunks,
} from "./insights";
import { dailyActivitySummaries, overviewGranularity, overviewHistoryStart } from "./overview";
import { previousRange, type Range } from "./time";

const categories: Category[] = [
  { id: 1, name: "Focus", color: "#000", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Media", color: "#000", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Hidden", color: "#000", isProductive: false, isNeutral: true, isIgnored: true, sortOrder: 3 },
];
const rules: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 3 },
  { id: 2, matchType: "process", pattern: "video.exe", categoryId: 2, priority: 3 },
  { id: 3, matchType: "process", pattern: "hidden.exe", categoryId: 3, priority: 3 },
];
const classifier = buildClassifier(categories, rules, new Set());
const range: Range = { start: new Date(2026, 5, 8), end: new Date(2026, 5, 11) };
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 5, day, hour, minute).getTime() / 1000;
const make = (
  id: number,
  start: number,
  end: number,
  process: string,
  isAfk = false,
): Session => ({ id, start, end, process, title: "", domain: null, isAfk });
const sessions: Session[] = [
  make(1, at(5, 9), at(5, 10), "code.exe"),
  make(2, at(6, 9), at(6, 10), "video.exe"),
  make(3, at(7, 23, 30), at(8, 0, 30), "code.exe"),
  make(4, at(8, 9), at(8, 11), "code.exe"),
  make(5, at(8, 11, 1), at(8, 12), "video.exe"),
  make(6, at(8, 12), at(8, 12, 30), "idle", true),
  make(7, at(9, 23, 30), at(10, 0, 30), "video.exe"),
  make(8, at(10, 8), at(10, 9), "hidden.exe"),
  make(9, at(10, 10), at(10, 11), "unknown.exe"),
];

describe("aggregateInsightsSessions", () => {
  it("matches the prior independent aggregation pipeline", () => {
    const previous = previousRange(range);
    const granularity = overviewGranularity(range);
    const historyRange = {
      start: overviewHistoryStart(range, granularity, "Sunday"),
      end: range.end,
    };
    const visible = sessions.filter((session) => classifier(session)?.isIgnored !== true);
    const current = clipSessions(
      visible,
      range.start.getTime() / 1000,
      range.end.getTime() / 1000,
    );
    const prior = clipSessions(
      visible,
      previous.start.getTime() / 1000,
      previous.end.getTime() / 1000,
    );
    const history = clipSessions(
      visible,
      historyRange.start.getTime() / 1000,
      historyRange.end.getTime() / 1000,
    );

    const actual = aggregateInsightsSessions(sessions, range, classifier, 120, "Sunday");

    expect(actual.current).toEqual(current);
    expect(actual.kpis).toEqual(computeKpis(current, classifier, 120));
    expect(actual.currentRanked).toEqual(topApps(current, classifier));
    expect(actual.previousRanked).toEqual(topApps(prior, classifier));
    expect(actual.currentDaily).toEqual(dailySecondsByApp(current, range));
    expect(actual.previousDaily).toEqual(dailySecondsByApp(prior, previous));
    expect(actual.historyDays).toEqual(dailyActivitySummaries(history, historyRange, classifier));
  });

  it("sorts an unexpected unordered input before computing focus chains", () => {
    const expected = aggregateInsightsSessions(sessions, range, classifier, 120, "Sunday");
    const shuffled = [...sessions].sort((left, right) => right.id - left.id);
    const actual = aggregateInsightsSessions(shuffled, range, classifier, 120, "Sunday");
    expect(actual.current).toEqual(expected.current);
    expect(actual.kpis).toEqual(expected.kpis);
  });
});

describe("minimum app time", () => {
  // Two days of real use inside a ten-day window, plus two small apps that
  // straddle a 1 min/day bar: 150s clears two active days, 100s does not.
  const rare: Session[] = [
    make(1, at(8, 9), at(8, 11), "code.exe"),
    make(2, at(9, 9), at(9, 11), "code.exe"),
    make(3, at(8, 12), at(8, 12) + 150, "often.exe"),
    make(4, at(9, 12), at(9, 12) + 100, "seldom.exe"),
  ];
  const modelOver = (start: Date, end: Date) =>
    buildInsightsModel({
      sessions: rare,
      range: { start, end },
      categories,
      rules,
      browserProcesses: [],
      weekStart: "Sunday",
      weeklyGoalHours: 0,
      minAppSecondsPerDay: 60,
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date",
    });

  it("scales the bar by days that recorded activity, not calendar days", () => {
    const model = modelOver(new Date(2026, 5, 1), new Date(2026, 5, 11));
    expect(model.apps.map((app) => app.process)).toEqual(["code.exe", "often.exe"]);
    expect(model.hiddenAppCount).toBe(1);
  });

  it("keeps the same apps eligible when the range widens", () => {
    const wide = modelOver(new Date(2026, 5, 1), new Date(2026, 5, 11));
    const tight = modelOver(new Date(2026, 5, 8), new Date(2026, 5, 10));
    expect(tight.apps.map((app) => app.process)).toEqual(wide.apps.map((app) => app.process));
  });
});

describe("packed Insights transport", () => {
  it("preserves long-range model output without transferring titles or domains", () => {
    const longRange: Range = {
      start: new Date(2026, 4, 25),
      end: new Date(2026, 5, 11),
    };
    const request = {
      sessions,
      range: longRange,
      categories,
      rules,
      browserProcesses: [] as string[],
      weekStart: "Sunday" as const,
      weeklyGoalHours: 10,
      minAppSecondsPerDay: 0,
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date" as const,
    };
    expect(buildInsightsModelFromPacked(packInsightsRequest(request))).toEqual(
      buildInsightsModel(request),
    );
  });

  it("can pack in yielding chunks without changing the payload", async () => {
    const request = {
      sessions,
      range: { start: new Date(2026, 4, 25), end: new Date(2026, 5, 11) },
      categories,
      rules,
      browserProcesses: [] as string[],
      weekStart: "Sunday" as const,
      weeklyGoalHours: 10,
      minAppSecondsPerDay: 0,
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date" as const,
    };
    let yields = 0;
    const chunked = await packInsightsRequestInChunks(
      request,
      async () => {
        yields += 1;
      },
      3,
    );
    expect(chunked).toEqual(packInsightsRequest(request));
    expect(yields).toBe(2);
  });
});
