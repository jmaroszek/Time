import { expect, it } from "vitest";
import { buildActivityIndex, queryActivityIndex, type ActivityQuery } from "./activity";
import { buildInsightsModel, buildInsightsModelFromPacked, packInsightsRequest, type InsightsRequest } from "./insights";
import { SessionWindowCache } from "./sessionWindowCache";
import type { Category, Rule } from "./classify";
import type { Session } from "./metrics";

const categories: Category[] = ["Productive", "Neutral", "Unproductive", "Ignored"].map((name, i) => ({
  id: i + 1, name, color: "#000000", isProductive: i === 0,
  isNeutral: i === 1, isIgnored: i === 3, sortOrder: i,
}));
const rules: Rule[] = categories.map((category, i) => ({
  id: i + 1, matchType: "process", pattern: `app${i}.exe`, categoryId: category.id, priority: 1,
}));
rules.push({ id: 5, matchType: "domain", pattern: "example.com", categoryId: 1, priority: 0 });

// A deliberately slow oracle: count individual elapsed seconds, assigning
// each to its local calendar day. No production clipping, classification,
// date-splitting, packing, cache, or aggregation helpers determine expectations.
function countSeconds(rows: Session[], start: number, end: number) {
  let active = 0, productive = 0, unknown = 0, library = 0;
  const days = new Map<string, number>();
  const hours = Array<number>(24).fill(0);
  let websites = 0;
  for (const row of rows) {
    if (row.isAfk) continue;
    const category = row.categoryOverrideId ?? (row.process === "app4.exe" && row.domain?.endsWith("example.com")
      ? 1 : Number(row.process[3]) + 1);
    for (let second = row.start; second < row.end; second++) {
      if (second < start || second >= end) continue;
      library++;
      if (category === 4) continue;
      active++;
      if (row.process === "app4.exe" && row.domain) websites++;
      if (category === 1) productive++;
      if (category === 5) unknown++;
      const date = new Date(second * 1000).toDateString();
      hours[new Date(second * 1000).getHours()]++;
      days.set(date, (days.get(date) ?? 0) + 1);
    }
  }
  return { active, productive, unknown, library, days, hours, websites };
}

it.each([[2, 8], [10, 1], [3, 5], [9, 4], [0, 10]])(
  "conserves independently counted seconds across views, workers and cache around 2026/%s/%s",
  async (month, date) => {
    const start = new Date(2026, month, date).getTime() / 1000;
    const end = new Date(2026, month, date + 2).getTime() / 1000;
    let random = 1729;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const rows: Session[] = [];
    let cursor = start - 1800;
    while (cursor < end + 1800) {
      const id = rows.length + 1;
      const duration = next() % 9000 + 1;
      rows.push({ id, start: cursor, end: cursor + duration,
        process: `app${id % 5}.exe`, title: "", domain: id % 2 ? "docs.example.com" : null, isAfk: id % 7 === 0,
        categoryOverrideId: id % 11 === 0 ? 1 : null, isCorrected: id % 11 === 0 });
      cursor += duration + next() % 600;
    }
    const query: ActivityQuery = { startSec: start, endSec: end, search: "", typeFilter: "all",
      classificationFilter: "all", sort: "seconds", direction: "desc", windowSort: "seconds",
      windowDirection: "desc", entityOffset: 0, entityLimit: 100, windowOffset: 0, windowLimit: 100 };
    const base: InsightsRequest = { sessions: [...rows].reverse(), categories, rules, browserProcesses: ["app4.exe"],
      aliases: { "app0.exe": "Shared", "app1.exe": "Shared" },
      range: { start: new Date(start * 1000), end: new Date(end * 1000) },
      weekStart: "Monday", weeklyGoalHours: 20, minAppSecondsPerDay: 0,
      focusChainMaxGapSeconds: 300, hideUtilityApps: false, dayStartHour: 0, dayEndHour: 24,
      labelMode: "date", firstObservedSec: start - 86400, analysisCutoffSec: end, memberBreakdown: true };
    for (const cutoff of [end, start + 11111]) {
      const expected = countSeconds(rows, start, cutoff);
      const request = { ...base, analysisCutoffSec: cutoff };
      const cache = new SessionWindowCache(() => end + 86400);
      const cached = await cache.load(start, end, async () => rows);
      for (const model of [buildInsightsModel(request),
        buildInsightsModelFromPacked(packInsightsRequest(request)),
        buildInsightsModel({ ...request, sessions: cached })]) {
        expect(model.kpis.totalSec).toBe(expected.active);
        expect(model.kpis.prodSec).toBe(expected.productive);
        expect(model.kpis.uncategorizedSec).toBe(expected.unknown);
        expect(model.apps.reduce((sum, row) => sum + row.seconds, 0)).toBe(expected.active);
        expect(model.websites.reduce((sum, row) => sum + row.seconds, 0)).toBe(expected.websites);
        expect(model.members!.reduce((sum, row) => sum + row.seconds, 0)).toBe(expected.active);
        for (const day of model.historyDays.filter((day) => day.date.getTime() >= start * 1000)) {
          expect(day.trackedSeconds).toBe(expected.days.get(day.date.toDateString()) ?? 0);
        }
      }
      const activity = queryActivityIndex(buildActivityIndex(base), { ...query, endSec: cutoff });
      expect(activity.totalSeconds).toBe(expected.library);
      expect(activity.catalog.rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(expected.library);
    }
    const dayEnd = new Date(2026, month, date + 1).getTime() / 1000;
    const expectedDay = countSeconds(rows, start, dayEnd);
    const singleDay = buildInsightsModel({ ...base,
      range: { start: base.range.start, end: new Date(dayEnd * 1000) }, analysisCutoffSec: dayEnd });
    expect(singleDay.hourly!.map((hour) => hour.trackedSeconds)).toEqual(expectedDay.hours);
  },
);
