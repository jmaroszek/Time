import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";
import {
  clipSessions,
  computeKpis,
  dailySeconds,
  dailySecondsByApp,
  goalPace,
  hourMatrix,
  rollingMean,
  splitAtMidnights,
  topApps,
  welchTTestPValue,
  withDeltas,
  type AppUsage,
  type Session,
} from "./metrics";
import { dayKey } from "./time";

const CATS: Category[] = [
  { id: 1, name: "Dev", color: "#378ADD", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Gaming", color: "#D85A30", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
];
const RULES: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 100 },
  { id: 2, matchType: "process", pattern: "obsidian.exe", categoryId: 1, priority: 100 },
  { id: 3, matchType: "process", pattern: "apex.exe", categoryId: 2, priority: 100 },
];
const classify = buildClassifier(CATS, RULES, new Set());

let nextId = 1;
function sess(start: number, end: number, process = "code.exe", isAfk = false): Session {
  return { id: nextId++, start, end, process, title: "", domain: null, isAfk };
}

// A local-midnight base keeps day-split assertions deterministic.
const T0 = new Date(2026, 5, 8).getTime() / 1000; // Mon Jun 8 2026 00:00 local

describe("clipSessions", () => {
  it("clips overlapping edges and drops outside sessions", () => {
    const sessions = [sess(0, 100), sess(150, 250), sess(300, 400)];
    const clipped = clipSessions(sessions, 50, 320);
    expect(clipped.map((s) => [s.start, s.end])).toEqual([
      [50, 100],
      [150, 250],
      [300, 320],
    ]);
  });
});

describe("computeKpis", () => {
  it("computes totals and productive fraction", () => {
    const k = computeKpis(
      [sess(0, 3600, "code.exe"), sess(3600, 5400, "apex.exe")],
      classify,
    );
    expect(k.totalSec).toBe(5400);
    expect(k.prodSec).toBe(3600);
    expect(k.prodFraction).toBeCloseTo(2 / 3);
  });

  it("excludes afk from totals", () => {
    const k = computeKpis([sess(0, 3600), sess(3600, 7200, "afk", true)], classify);
    expect(k.totalSec).toBe(3600);
  });

  it("focus chain spans contiguous productive sessions", () => {
    // code -> obsidian back-to-back: one 2h chain
    const k = computeKpis([sess(0, 3600, "code.exe"), sess(3600, 7200, "obsidian.exe")], classify);
    expect(k.longestFocusSec).toBe(7200);
  });

  it("focus chain broken by a non-productive session", () => {
    const k = computeKpis(
      [sess(0, 3600), sess(3600, 3900, "apex.exe"), sess(3900, 6000)],
      classify,
    );
    expect(k.longestFocusSec).toBe(3600);
  });

  it("focus chain broken by afk", () => {
    const k = computeKpis(
      [sess(0, 3600), sess(3600, 4000, "afk", true), sess(4000, 6000)],
      classify,
    );
    expect(k.longestFocusSec).toBe(3600);
  });

  it("focus chain broken by a tracking gap > 60s", () => {
    const k = computeKpis([sess(0, 3600), sess(3700, 5000)], classify);
    expect(k.longestFocusSec).toBe(3600);
  });

  it("focus chain survives a sub-60s gap", () => {
    const k = computeKpis([sess(0, 3600), sess(3630, 5000)], classify);
    expect(k.longestFocusSec).toBe(3600 + 1370);
  });

  it("honors a custom max-gap: a 90s gap survives a 120s threshold", () => {
    const sessions = [sess(0, 3600), sess(3690, 5000)]; // 90s gap
    expect(computeKpis(sessions, classify).longestFocusSec).toBe(3600); // default 60s breaks it
    expect(computeKpis(sessions, classify, 120).longestFocusSec).toBe(3600 + 1310); // 120s bridges it
  });

  it("uncategorized sessions break the chain but count toward total", () => {
    const k = computeKpis([sess(0, 3600), sess(3600, 4000, "mystery.exe")], classify);
    expect(k.totalSec).toBe(4000);
    expect(k.longestFocusSec).toBe(3600);
  });
});

describe("goalPace", () => {
  const week = { start: new Date(2026, 5, 7), end: new Date(2026, 5, 10) }; // 3 days

  it("a single day targets the daily goal", () => {
    const today = { start: new Date(2026, 5, 9), end: new Date(2026, 5, 10) };
    const p = goalPace(2 * 3600, today, 21);
    expect(p.targetHours).toBeCloseTo(3); // 21 / 7
    expect(p.doneHours).toBeCloseTo(2);
    expect(p.dailyGoalHours).toBeCloseTo(3); // 21 / 7
    expect(p.avgPerDayHours).toBeCloseTo(2); // 2h over 1 day
  });

  it("a multi-day range scales the target and averages per day", () => {
    const p = goalPace(7.5 * 3600, week, 21);
    expect(p.targetHours).toBeCloseTo((21 * 3) / 7); // 9h: 3 days of a 21h/week goal
    expect(p.doneHours).toBeCloseTo(7.5);
    expect(p.dailyGoalHours).toBeCloseTo(3);
    expect(p.avgPerDayHours).toBeCloseTo(2.5); // 7.5h over 3 days
    expect(p.fraction).toBeCloseTo(7.5 / 9);
  });

  it("longer ranges scale the target", () => {
    const r = { start: new Date(2026, 4, 10), end: new Date(2026, 4, 24) }; // 14 days
    const p = goalPace(28 * 3600, r, 20);
    expect(p.targetHours).toBe(40); // 20 * 14 / 7
    expect(p.avgPerDayHours).toBeCloseTo(2); // 28h over 14 days
    expect(p.fraction).toBeCloseTo(0.7);
  });

  it("meeting the daily-average goal reads as on pace (fraction >= 1)", () => {
    const p = goalPace(9 * 3600, week, 21); // 9h over 3 days = 3h/day == daily goal
    expect(p.avgPerDayHours).toBeCloseTo(3);
    expect(p.fraction).toBeGreaterThanOrEqual(1);
  });
});

describe("topApps / withDeltas", () => {
  it("groups by process sorted by time", () => {
    const apps = topApps(
      [sess(0, 100, "code.exe"), sess(100, 400, "apex.exe"), sess(400, 450, "code.exe")],
      classify,
    );
    expect(apps[0].process).toBe("apex.exe");
    expect(apps[1].seconds).toBe(150);
  });

  it("delta direction is category-aware when the change is significant", () => {
    // Consistent daily levels that clearly shift between periods.
    const daily = (vals: number[]) => new Map([["code.exe", vals], ["apex.exe", vals]]);
    const cur: AppUsage[] = [
      { process: "code.exe", seconds: 1400, category: CATS[0] }, // productive, up
      { process: "apex.exe", seconds: 1400, category: CATS[1] }, // non-productive, up
    ];
    const prev: AppUsage[] = [
      { process: "code.exe", seconds: 700, category: CATS[0] },
      { process: "apex.exe", seconds: 700, category: CATS[1] },
    ];
    const deltas = withDeltas(cur, prev, {
      currentDaily: daily([200, 200, 200, 200, 200, 200, 200]),
      previousDaily: daily([100, 100, 100, 100, 100, 100, 100]),
    });
    expect(deltas[0].direction).toBe("good");
    expect(deltas[1].direction).toBe("bad");
    expect(deltas[0].deltaFraction).toBeCloseTo(1.0);
    expect(deltas[0].pValue).not.toBeNull();
  });

  it("noisy small changes stay neutral (not significant)", () => {
    const deltas = withDeltas(
      [{ process: "code.exe", seconds: 24.5 * 3600, category: CATS[0] }],
      [{ process: "code.exe", seconds: 24 * 3600, category: CATS[0] }],
      {
        currentDaily: new Map([["code.exe", [3, 4, 3, 4, 3, 4, 3.5].map((h) => h * 3600)]]),
        previousDaily: new Map([["code.exe", [4, 3, 4, 3, 4, 3, 3].map((h) => h * 3600)]]),
      },
    );
    expect(deltas[0].direction).toBe("neutral");
    expect(deltas[0].pValue).toBeGreaterThan(0.1);
  });

  it("without daily samples, falls back to >=25% and >=15min", () => {
    const big = withDeltas(
      [{ process: "code.exe", seconds: 4000, category: CATS[0] }],
      [{ process: "code.exe", seconds: 2000, category: CATS[0] }],
    );
    expect(big[0].direction).toBe("good");
    const small = withDeltas(
      [{ process: "code.exe", seconds: 2100, category: CATS[0] }],
      [{ process: "code.exe", seconds: 2000, category: CATS[0] }],
    );
    expect(small[0].direction).toBe("neutral"); // +5%: business as usual
  });

  it("new apps have null delta and neutral direction", () => {
    const deltas = withDeltas([{ process: "new.exe", seconds: 100, category: CATS[0] }], []);
    expect(deltas[0].deltaFraction).toBeNull();
    expect(deltas[0].direction).toBe("neutral");
  });

  it("neutral categories are never judged, even on a significant change", () => {
    const neutral = { ...CATS[1], isProductive: false, isNeutral: true }; // e.g. games
    const daily = (vals: number[]) => new Map([["apex.exe", vals]]);
    const deltas = withDeltas(
      [{ process: "apex.exe", seconds: 1400, category: neutral }],
      [{ process: "apex.exe", seconds: 700, category: neutral }],
      {
        currentDaily: daily([200, 200, 200, 200, 200, 200, 200]),
        previousDaily: daily([100, 100, 100, 100, 100, 100, 100]),
      },
    );
    // The change is statistically significant, but neutral time is uncolored.
    expect(deltas[0].pValue).not.toBeNull();
    expect(deltas[0].direction).toBe("neutral");
  });
});

describe("welchTTestPValue (pinned to scipy.stats.ttest_ind equal_var=False)", () => {
  it("matches scipy on a moderate overlap", () => {
    expect(welchTTestPValue([1, 2, 3, 4, 5], [2, 3, 4, 5, 6])!).toBeCloseTo(0.34659350708733416, 8);
  });
  it("matches scipy on clearly separated samples", () => {
    expect(welchTTestPValue([5, 6, 4, 7, 5, 6, 4], [2, 1, 3, 2, 2, 1, 3])!).toBeCloseTo(
      5.825391139442523e-5,
      10,
    );
  });
  it("matches scipy on near-identical samples", () => {
    expect(welchTTestPValue([3, 4, 3, 4, 3, 4, 3], [3.5, 3, 4, 3, 4, 3, 4])!).toBeCloseTo(
      0.8006476875457705,
      8,
    );
  });
  it("identical constant samples give p=1, shifted constants give p=0", () => {
    expect(welchTTestPValue([2, 2, 2], [2, 2, 2])).toBe(1);
    expect(welchTTestPValue([2, 2, 2], [3, 3, 3])).toBe(0);
  });
  it("returns null when a sample has fewer than 2 points", () => {
    expect(welchTTestPValue([1], [1, 2, 3])).toBeNull();
  });
});

describe("dailySecondsByApp", () => {
  it("builds zero-filled per-app daily arrays", () => {
    const range = { start: new Date(2026, 5, 8), end: new Date(2026, 5, 11) };
    const byApp = dailySecondsByApp(
      [sess(T0 + 3600, T0 + 7200, "code.exe"), sess(T0 + 90000, T0 + 93600, "apex.exe")],
      range,
    );
    expect(byApp.get("code.exe")).toEqual([3600, 0, 0]);
    expect(byApp.get("apex.exe")).toEqual([0, 3600, 0]);
  });
});

describe("splitAtMidnights / dailySeconds", () => {
  it("splits a session crossing midnight", () => {
    const start = T0 + 23 * 3600 + 30 * 60; // 23:30 Mon
    const chunks = splitAtMidnights(start, start + 3600); // -> 00:30 Tue
    expect(chunks).toHaveLength(2);
    expect(chunks[0].endSec - chunks[0].startSec).toBe(1800);
    expect(chunks[1].endSec - chunks[1].startSec).toBe(1800);
    expect(dayKey(chunks[0].dayStart)).toBe("2026-06-08");
    expect(dayKey(chunks[1].dayStart)).toBe("2026-06-09");
  });

  it("dailySeconds zero-fills empty days", () => {
    const range = { start: new Date(2026, 5, 8), end: new Date(2026, 5, 11) };
    const daily = dailySeconds([sess(T0 + 3600, T0 + 7200)], () => true, range);
    expect(daily.get("2026-06-08")).toBe(3600);
    expect(daily.get("2026-06-09")).toBe(0);
    expect(daily.get("2026-06-10")).toBe(0);
  });
});

describe("rollingMean", () => {
  it("averages a trailing window", () => {
    expect(rollingMean([2, 4, 6], 7)).toEqual([2, 3, 4]);
    expect(rollingMean([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });
});

describe("hourMatrix", () => {
  it("buckets seconds into local day-of-week x hour cells", () => {
    // Mon Jun 8 2026, 09:30-11:00
    const m = hourMatrix([sess(T0 + 9.5 * 3600, T0 + 11 * 3600)], () => true);
    expect(m[1][9]).toBe(1800);
    expect(m[1][10]).toBe(3600);
    expect(m[1][11]).toBe(0);
  });
});
