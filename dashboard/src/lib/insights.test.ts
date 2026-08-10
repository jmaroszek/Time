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
  { id: 4, name: "System", color: "#000", isProductive: false, isNeutral: true, isIgnored: false, sortOrder: 4 },
];
const rules: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 3 },
  { id: 2, matchType: "process", pattern: "video.exe", categoryId: 2, priority: 3 },
  { id: 3, matchType: "process", pattern: "hidden.exe", categoryId: 3, priority: 3 },
  { id: 4, matchType: "process", pattern: "explorer.exe", categoryId: 4, priority: 3 },
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
  domain: string | null = null,
): Session => ({ id, start, end, process, title: "", domain, isAfk });
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
// code.exe and video.exe are unrelated, but aliasing them to one name is the
// only way to exercise merged rows through the whole Insights pipeline.
const aliases = { "code.exe": "Studio", "video.exe": "Studio" };

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

  it("still matches it once aliases merge rows", () => {
    // Insights runs its own single pass instead of calling topApps, so the two
    // have to be held to the same definition of an app row — including which
    // processes fold together and which category survives the fold.
    const previous = previousRange(range);
    const visible = sessions.filter((session) => classifier(session)?.isIgnored !== true);
    const current = clipSessions(visible, range.start.getTime() / 1000, range.end.getTime() / 1000);
    const prior = clipSessions(
      visible,
      previous.start.getTime() / 1000,
      previous.end.getTime() / 1000,
    );

    const actual = aggregateInsightsSessions(sessions, range, classifier, 120, "Sunday", aliases);

    expect(actual.currentRanked).toEqual(topApps(current, classifier, aliases));
    expect(actual.previousRanked).toEqual(topApps(prior, classifier, aliases));
    expect(actual.currentDaily).toEqual(dailySecondsByApp(current, range, aliases));
    expect(actual.previousDaily).toEqual(dailySecondsByApp(prior, previous, aliases));
    expect(actual.currentRanked.find((row) => row.name === "Studio")?.processes).toEqual([
      "code.exe",
      "video.exe",
    ]);
  });

  it("sorts an unexpected unordered input before computing focus chains", () => {
    const expected = aggregateInsightsSessions(sessions, range, classifier, 120, "Sunday");
    const shuffled = [...sessions].sort((left, right) => right.id - left.id);
    const actual = aggregateInsightsSessions(shuffled, range, classifier, 120, "Sunday");
    expect(actual.current).toEqual(expected.current);
    expect(actual.kpis).toEqual(expected.kpis);
  });

  it("preserves range and daily focus chains through neutral activity", () => {
    const focusSessions = [
      make(20, at(8, 9), at(8, 10), "code.exe"),
      make(21, at(8, 10), at(8, 10, 30), "explorer.exe"),
      make(22, at(8, 10, 30), at(8, 11, 30), "code.exe"),
    ];
    const actual = aggregateInsightsSessions(
      focusSessions,
      { start: new Date(2026, 5, 8), end: new Date(2026, 5, 9) },
      classifier,
      60,
      "Sunday",
    );
    expect(actual.kpis.longestFocusSec).toBe(2 * 3600);
    expect(actual.historyDays[actual.historyDays.length - 1]?.longestFocusSeconds).toBe(2 * 3600);
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
      aliases: {},
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date",
    });

  it("scales the bar by days that recorded activity, not calendar days", () => {
    const model = modelOver(new Date(2026, 5, 1), new Date(2026, 5, 11));
    expect(model.apps.map((app) => app.name)).toEqual(["Code", "Often"]);
    expect(model.hiddenAppCount).toBe(1);
  });

  it("keeps the same apps eligible when the range widens", () => {
    const wide = modelOver(new Date(2026, 5, 1), new Date(2026, 5, 11));
    const tight = modelOver(new Date(2026, 5, 8), new Date(2026, 5, 10));
    expect(tight.apps.map((app) => app.key)).toEqual(wide.apps.map((app) => app.key));
  });

  it("weighs the bar against merged time, not each half separately", () => {
    // Two builds at 100s each on their own active day: both fall under a
    // 150s bar apart, and clear it together. Filtering before the merge would
    // hide an app the user spends real time in.
    const split: Session[] = [
      make(1, at(8, 9), at(8, 11), "code.exe"),
      make(2, at(9, 9), at(9, 11), "code.exe"),
      make(3, at(8, 12), at(8, 12) + 100, "time.exe"),
      make(4, at(9, 12), at(9, 12) + 100, "time-tracker.exe"),
    ];
    const model = buildInsightsModel({
      sessions: split,
      range: { start: new Date(2026, 5, 8), end: new Date(2026, 5, 10) },
      categories,
      rules,
      browserProcesses: [],
      weekStart: "Sunday",
      weeklyGoalHours: 0,
      minAppSecondsPerDay: 75,
      aliases: { "time.exe": "Time", "time-tracker.exe": "Time" },
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date",
    });
    expect(model.apps.map((app) => app.name)).toEqual(["Code", "Time"]);
    expect(model.hiddenAppCount).toBe(0);
  });
});

describe("ranked websites", () => {
  const websiteRules: Rule[] = [
    ...rules,
    { id: 10, matchType: "domain", pattern: "google.com", categoryId: 1, priority: 1 },
    { id: 11, matchType: "domain", pattern: "mail.google.com", categoryId: 2, priority: 1 },
  ];
  const websiteSessions: Session[] = [
    make(30, at(5, 9), at(5, 9) + 600, "chrome.exe", false, "docs.google.com"),
    make(31, at(5, 10), at(5, 10) + 120, "chrome.exe", false, "mail.google.com"),
    make(32, at(8, 9), at(8, 9) + 1_200, "chrome.exe", false, "docs.google.com"),
    make(33, at(8, 10), at(8, 10) + 300, "chrome.exe", false, "mail.google.com"),
    make(34, at(8, 11), at(8, 11) + 1_800, "chrome.exe"),
    // A stored domain is a Website only while its process is configured as a browser.
    make(35, at(8, 12), at(8, 12) + 600, "firefox.exe", false, "example.com"),
  ];

  const model = buildInsightsModel({
    sessions: websiteSessions,
    range,
    categories,
    rules: websiteRules,
    browserProcesses: ["chrome.exe"],
    weekStart: "Sunday",
    weeklyGoalHours: 0,
    // Deliberately too high for any app: it must not silently erase websites.
    minAppSecondsPerDay: 3_600,
    aliases: { "docs.google.com": "Google Docs" },
    focusChainMaxGapSeconds: 120,
    dayStartHour: 0,
    dayEndHour: 24,
    labelMode: "date",
  });

  it("ranks exact normalized hosts instead of folding them into a parent", () => {
    expect(model.websites.map((website) => website.key)).toEqual([
      "docs.google.com",
      "mail.google.com",
    ]);
    expect(model.websites.map((website) => website.name)).toEqual([
      "Google Docs",
      "mail.google.com",
    ]);
    expect(model.websites.map((website) => website.category?.name)).toEqual(["Focus", "Media"]);
    expect(model.websites.map((website) => website.previousSeconds)).toEqual([600, 120]);
    expect(model.apps).toEqual([]);
  });

  it("reports browser time that could not be assigned to a website", () => {
    expect(model.websiteCoverage).toEqual({
      totalSeconds: 3_300,
      missingSeconds: 1_800,
      missingFraction: 1_800 / 3_300,
    });
  });
});

describe("packed Insights transport", () => {
  it("preserves long-range model output without transferring titles", () => {
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
      aliases,
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date" as const,
    };
    expect(buildInsightsModelFromPacked(packInsightsRequest(request))).toEqual(
      buildInsightsModel(request),
    );
  });

  it("deduplicates domains into a compact column without changing website output", () => {
    const request = {
      sessions: [
        make(0, at(8, 9), at(8, 10), "chrome.exe", false, "docs.google.com"),
        make(1, at(8, 10), at(8, 11), "chrome.exe", false, "docs.google.com"),
        make(2, at(8, 11), at(8, 12), "chrome.exe"),
      ],
      range,
      categories,
      rules: [
        ...rules,
        { id: 12, matchType: "domain", pattern: "docs.google.com", categoryId: 1, priority: 1 },
      ] as Rule[],
      browserProcesses: ["chrome.exe"],
      weekStart: "Sunday" as const,
      weeklyGoalHours: 0,
      minAppSecondsPerDay: 0,
      aliases: {},
      focusChainMaxGapSeconds: 120,
      dayStartHour: 0,
      dayEndHour: 24,
      labelMode: "date" as const,
    };
    const packed = packInsightsRequest(request);

    expect(packed.domains).toEqual(["docs.google.com"]);
    expect([...packed.domainIndices]).toEqual([1, 1, 0]);
    expect(buildInsightsModelFromPacked(packed)).toEqual(buildInsightsModel(request));
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
      aliases,
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
