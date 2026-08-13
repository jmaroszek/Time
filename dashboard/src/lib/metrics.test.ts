import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";
import {
  clipSessions,
  computeKpis,
  dailySecondsByApp,
  goalPace,
  rollingMean,
  splitAtMidnights,
  topApps,
  robustDeltaFraction,
  withDeltas,
  type AppUsage,
  type Session,
} from "./metrics";
import { appGroupKey, cleanProcessName } from "./format";
import { dayKey } from "./time";

const CATS: Category[] = [
  { id: 1, name: "Dev", color: "#378ADD", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Gaming", color: "#D85A30", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Music", color: "#8A8F98", isProductive: false, isNeutral: true, isIgnored: false, sortOrder: 3 },
];
const RULES: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 100 },
  { id: 2, matchType: "process", pattern: "obsidian.exe", categoryId: 1, priority: 100 },
  { id: 3, matchType: "process", pattern: "apex.exe", categoryId: 2, priority: 100 },
  { id: 4, matchType: "process", pattern: "spotify.exe", categoryId: 3, priority: 100 },
];
const classify = buildClassifier(CATS, RULES, new Set());

let nextId = 1;
function sess(start: number, end: number, process = "code.exe", isAfk = false): Session {
  return { id: nextId++, start, end, process, title: "", domain: null, isAfk };
}

/** One app row, as `topApps` would build it from a single un-aliased process. */
function app(process: string, seconds: number, category: Category | null): AppUsage {
  return {
    key: appGroupKey(process),
    name: cleanProcessName(process),
    processes: [process],
    seconds,
    category,
  };
}

/** Daily series are keyed by app row, not by raw process, because that is how
 *  `withDeltas` looks them up. */
function dailySeries(process: string, values: number[]): Map<string, number[]> {
  return new Map([[appGroupKey(process), values]]);
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

  it("separates time no rule claimed from time that is merely unproductive", () => {
    // The distinction the Insights tiles rest on. apex.exe is classified and
    // simply not productive; nothing.exe matches no rule at all. Both leave
    // prodSec at zero, and only one of them means "there is nothing to show
    // yet" rather than "you were not productive".
    const unproductive = computeKpis([sess(0, 3600, "apex.exe")], classify);
    expect(unproductive.prodSec).toBe(0);
    expect(unproductive.uncategorizedSec).toBe(0);

    const unclassified = computeKpis([sess(0, 3600, "nothing.exe")], classify);
    expect(unclassified.prodSec).toBe(0);
    expect(unclassified.uncategorizedSec).toBe(3600);
    expect(unclassified.uncategorizedSec).toBe(unclassified.totalSec);
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

  it("focus chain broken by a gap over the default 300s", () => {
    const k = computeKpis([sess(0, 3600), sess(3910, 5000)], classify);
    expect(k.longestFocusSec).toBe(3600);
  });

  it("focus chain survives a gap under the default 300s", () => {
    const k = computeKpis([sess(0, 3600), sess(3890, 5000)], classify);
    expect(k.longestFocusSec).toBe(3600 + 1110);
  });

  it("only explicitly unproductive activity and AFK end the chain", () => {
    const gap = 600;
    for (const [what, interruption] of [
      ["unproductive", sess(3600, 3605, "apex.exe")],
      ["afk", sess(3600, 3605, "afk", true)],
    ] as const) {
      const k = computeKpis([sess(0, 3600), interruption, sess(3605, 6000)], classify, gap);
      expect(k.longestFocusSec, `${what} must end the chain`).toBe(3600);
    }
  });

  it("neutral and uncategorized activity preserve a chain without adding duration", () => {
    for (const [what, interruption] of [
      ["neutral", sess(3600, 4800, "spotify.exe")],
      ["uncategorized", sess(3600, 4800, "unknown.exe")],
    ] as const) {
      const k = computeKpis([sess(0, 3600), interruption, sess(4800, 6000)], classify, 60);
      expect(k.longestFocusSec, `${what} must preserve the chain`).toBe(4800);
    }
  });

  it("the same five seconds of nothing recorded is bridged instead", () => {
    const k = computeKpis([sess(0, 3600), sess(3605, 6000)], classify, 600);
    expect(k.longestFocusSec).toBe(3600 + 2395);
  });

  it("honors a custom max-gap: a 90s gap breaks a 60s threshold", () => {
    const sessions = [sess(0, 3600), sess(3690, 5000)]; // 90s gap
    expect(computeKpis(sessions, classify, 60).longestFocusSec).toBe(3600); // 60s breaks it
    expect(computeKpis(sessions, classify, 120).longestFocusSec).toBe(3600 + 1310); // 120s bridges it
  });

  it("uncategorized sessions count toward total and preserve existing focus", () => {
    const k = computeKpis(
      [sess(0, 3600), sess(3600, 4000, "mystery.exe"), sess(4000, 5000)],
      classify,
    );
    expect(k.totalSec).toBe(5000);
    expect(k.longestFocusSec).toBe(4600);
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
    expect(apps[0].name).toBe("Apex");
    expect(apps[0].processes).toEqual(["apex.exe"]);
    expect(apps[1].seconds).toBe(150);
  });

  it("folds processes that share an alias into one row", () => {
    // The dev build and the installed build of the same app. Before rows were
    // keyed by display name these were two rows, each labeled "Time" and each
    // holding half the truth.
    const aliases = { "time.exe": "Time", "time-tracker.exe": "Time" };
    const apps = topApps(
      [
        sess(0, 100, "time.exe"),
        sess(100, 400, "time-tracker.exe"),
        sess(400, 450, "time.exe"),
      ],
      classify,
      aliases,
    );
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Time");
    expect(apps[0].seconds).toBe(450);
    expect(apps[0].processes).toEqual(["time-tracker.exe", "time.exe"]);
  });

  it("splits the row again when one member's alias is cleared", () => {
    const sessions = [sess(0, 100, "time.exe"), sess(100, 400, "time-tracker.exe")];
    const apps = topApps(sessions, classify, { "time.exe": "Time" });
    expect(apps.map((row) => row.name)).toEqual(["Time-tracker", "Time"]);
  });

  it("a merged row is labeled by the category holding most of its time", () => {
    // Only the dev build carries a rule; the installed build is the majority.
    const aliases = { "code.exe": "Editor", "code-insiders.exe": "Editor" };
    const apps = topApps(
      [sess(0, 100, "code.exe"), sess(100, 1000, "code-insiders.exe")],
      classify,
      aliases,
    );
    expect(apps[0].category).toBeNull();
    const flipped = topApps(
      [sess(0, 1000, "code.exe"), sess(1000, 1100, "code-insiders.exe")],
      classify,
      aliases,
    );
    expect(flipped[0].category?.name).toBe("Dev");
  });

  it("compares a merged row against its merged baseline", () => {
    // The regression this guards: daily series keyed by raw process while rows
    // are keyed by group. Every merged row would miss its lookup and read as
    // brand new rather than as flat.
    const aliases = { "time.exe": "Time", "time-tracker.exe": "Time" };
    const current = topApps(
      [sess(0, 7 * 1800, "time.exe"), sess(0, 7 * 1800, "time-tracker.exe")],
      classify,
      aliases,
    );
    const previous = topApps([sess(0, 7 * 3600, "time.exe")], classify, aliases);
    const deltas = withDeltas(current, previous);
    expect(deltas[0].previousSeconds).toBe(7 * 3600);
    expect(deltas[0].deltaFraction).toBeCloseTo(0);
  });

  it("settles a tied merged row the same way whatever order sessions arrive in", () => {
    // Equal time in a classified and an unclassified member. Neither is the
    // majority, so the label falls to the tie-break rather than to whichever
    // session the loop happened to see first.
    const aliases = { "code.exe": "Split", "unknown.exe": "Split" };
    const classifiedFirst = topApps(
      [sess(0, 100, "code.exe"), sess(100, 200, "unknown.exe")],
      classify,
      aliases,
    );
    const unclassifiedFirst = topApps(
      [sess(0, 100, "unknown.exe"), sess(100, 200, "code.exe")],
      classify,
      aliases,
    );
    expect(classifiedFirst[0].category?.name).toBe("Dev");
    expect(unclassifiedFirst[0].category?.name).toBe("Dev");
  });

  it("breaks a tie between two real categories by category order", () => {
    // Dev (id 1) and Gaming (id 2) tied: the earlier category wins, whichever
    // session ran first.
    const aliases = { "code.exe": "Split", "apex.exe": "Split" };
    expect(
      topApps([sess(0, 100, "apex.exe"), sess(100, 200, "code.exe")], classify, aliases)[0].category
        ?.name,
    ).toBe("Dev");
    expect(
      topApps([sess(0, 100, "code.exe"), sess(100, 200, "apex.exe")], classify, aliases)[0].category
        ?.name,
    ).toBe("Dev");
  });

  it("orders equal-time rows by name so a rebuild does not reshuffle them", () => {
    const apps = topApps([sess(0, 100, "zebra.exe"), sess(100, 200, "alpha.exe")], classify);
    expect(apps.map((row) => row.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("delta direction is category-aware when the change is meaningful", () => {
    // A sustained doubling: 30 min/day up from 15, every day of the week.
    const daily = (v: number) =>
      new Map([
        [appGroupKey("code.exe"), Array(7).fill(v)],
        [appGroupKey("apex.exe"), Array(7).fill(v)],
      ]);
    const cur: AppUsage[] = [
      app("code.exe", 7 * 1800, CATS[0]), // productive, up
      app("apex.exe", 7 * 1800, CATS[1]), // non-productive, up
    ];
    const prev: AppUsage[] = [
      app("code.exe", 7 * 900, CATS[0]),
      app("apex.exe", 7 * 900, CATS[1]),
    ];
    const deltas = withDeltas(cur, prev, {
      currentDaily: daily(1800),
      previousDaily: daily(900),
    });
    expect(deltas[0].direction).toBe("good");
    expect(deltas[1].direction).toBe("bad");
    expect(deltas[0].deltaFraction).toBeCloseTo(1.0);
    expect(deltas[0].robustFraction).toBeCloseTo(1.0);
  });

  it("bursty apps are judged on size, not on day-to-day consistency", () => {
    // Weekend-only use, tripled. Welch's t-test left this gray; the change is real.
    const cur = [0, 0, 0, 0, 0, 4 * 3600, 4 * 3600];
    const prv = [0, 0, 0, 0, 0, 3600, 1.5 * 3600];
    const deltas = withDeltas(
      [app("apex.exe", 8 * 3600, CATS[1])],
      [app("apex.exe", 2.5 * 3600, CATS[1])],
      {
        currentDaily: dailySeries("apex.exe", cur),
        previousDaily: dailySeries("apex.exe", prv),
      },
    );
    expect(deltas[0].direction).toBe("bad");
  });

  it("a change carried by one day alone stays neutral", () => {
    // Steady 10 min/day plus a single five-hour binge: +413% overall, but the
    // habit did not change, so the badge stays gray.
    const cur = [600, 600, 600, 5 * 3600, 600, 600, 600];
    const prv = Array(7).fill(600);
    const deltas = withDeltas(
      [app("apex.exe", 3600 + 5 * 3600, CATS[1])],
      [app("apex.exe", 7 * 600, CATS[1])],
      {
        currentDaily: dailySeries("apex.exe", cur),
        previousDaily: dailySeries("apex.exe", prv),
      },
    );
    expect(deltas[0].deltaFraction).toBeGreaterThan(3);
    expect(deltas[0].robustFraction).toBeCloseTo(0);
    expect(deltas[0].direction).toBe("neutral");
  });

  it("large percentages on trivial amounts of time stay neutral", () => {
    // 1 min/day -> 3 min/day is +200%, but only +14 min across the week.
    const deltas = withDeltas(
      [app("code.exe", 7 * 180, CATS[0])],
      [app("code.exe", 7 * 60, CATS[0])],
      {
        currentDaily: dailySeries("code.exe", Array(7).fill(180)),
        previousDaily: dailySeries("code.exe", Array(7).fill(60)),
      },
    );
    expect(deltas[0].deltaFraction).toBeCloseTo(2.0);
    expect(deltas[0].direction).toBe("neutral");
  });

  it("small steady changes stay neutral however consistent they are", () => {
    // Near-zero variance made this significant under the t-test; +8% is not news.
    const deltas = withDeltas(
      [app("code.exe", 7 * 3888, CATS[0])],
      [app("code.exe", 7 * 3600, CATS[0])],
      {
        currentDaily: dailySeries("code.exe", [3890, 3886, 3888, 3887, 3889, 3888, 3888]),
        previousDaily: dailySeries("code.exe", [3600, 3601, 3599, 3600, 3602, 3598, 3600]),
      },
    );
    expect(deltas[0].direction).toBe("neutral");
  });

  it("without daily samples, falls back to the size gates alone", () => {
    const big = withDeltas(
      [app("code.exe", 4000, CATS[0])],
      [app("code.exe", 2000, CATS[0])],
    );
    expect(big[0].direction).toBe("good");
    const small = withDeltas(
      [app("code.exe", 2100, CATS[0])],
      [app("code.exe", 2000, CATS[0])],
    );
    expect(small[0].direction).toBe("neutral"); // +5%: business as usual
  });

  it("new apps have null delta and neutral direction", () => {
    const deltas = withDeltas([app("new.exe", 100, CATS[0])], []);
    expect(deltas[0].deltaFraction).toBeNull();
    expect(deltas[0].direction).toBe("neutral");
  });

  it("a near-zero baseline is flagged rather than divided by", () => {
    // 3 minutes across last week against 26 hours this week: arithmetically
    // +51698%, but the previous period is too thin to quote a ratio from.
    const deltas = withDeltas(
      [app("code.exe", 26 * 3600, CATS[0])],
      [app("code.exe", 181, CATS[0])],
      {
        currentDaily: dailySeries("code.exe", Array(7).fill(13371)),
        previousDaily: dailySeries("code.exe", [181, 0, 0, 0, 0, 0, 0]),
      },
    );
    expect(deltas[0].baselineNegligible).toBe(true);
    expect(deltas[0].previousSeconds).toBe(181);
    expect(deltas[0].direction).toBe("good"); // the change itself is still real
  });

  it("a real if small baseline is still worth a ratio", () => {
    // 30 min/day up to 2 h/day: a baseline this size divides honestly.
    const deltas = withDeltas(
      [app("code.exe", 7 * 7200, CATS[0])],
      [app("code.exe", 7 * 1800, CATS[0])],
      {
        currentDaily: dailySeries("code.exe", Array(7).fill(7200)),
        previousDaily: dailySeries("code.exe", Array(7).fill(1800)),
      },
    );
    expect(deltas[0].baselineNegligible).toBe(false);
    expect(deltas[0].deltaFraction).toBeCloseTo(3.0);
  });

  it("neutral categories are never judged, even on a meaningful change", () => {
    const neutral = { ...CATS[1], isProductive: false, isNeutral: true }; // e.g. games
    const daily = (v: number) => dailySeries("apex.exe", Array(7).fill(v));
    const deltas = withDeltas(
      [app("apex.exe", 7 * 1800, neutral)],
      [app("apex.exe", 7 * 900, neutral)],
      { currentDaily: daily(1800), previousDaily: daily(900) },
    );
    // The change clears every gate, but neutral time is uncolored.
    expect(deltas[0].robustFraction).toBeCloseTo(1.0);
    expect(deltas[0].direction).toBe("neutral");
  });
});

describe("robustDeltaFraction", () => {
  it("drops the single most-influential day", () => {
    // Removing the spike leaves the two weeks identical.
    expect(robustDeltaFraction([10, 10, 10, 900, 10], [10, 10, 10, 10, 10])).toBeCloseTo(0);
  });

  it("keeps a change spread across the range", () => {
    expect(robustDeltaFraction(Array(7).fill(200), Array(7).fill(100))).toBeCloseTo(1.0);
  });

  it("preserves the sign of a decline", () => {
    expect(robustDeltaFraction(Array(7).fill(50), Array(7).fill(200))).toBeCloseTo(-0.75);
  });

  it("returns null when the range is too short to leave a day out", () => {
    expect(robustDeltaFraction([100, 200], [50, 50])).toBeNull();
    expect(robustDeltaFraction(undefined, [1, 2, 3])).toBeNull();
  });

  it("reports Infinity when the remaining days had no prior usage", () => {
    expect(robustDeltaFraction([100, 100, 100], [0, 0, 500])).toBe(Infinity);
  });
});

describe("dailySecondsByApp", () => {
  it("builds zero-filled per-app daily arrays", () => {
    const range = { start: new Date(2026, 5, 8), end: new Date(2026, 5, 11) };
    const byApp = dailySecondsByApp(
      [sess(T0 + 3600, T0 + 7200, "code.exe"), sess(T0 + 90000, T0 + 93600, "apex.exe")],
      range,
    );
    expect(byApp.get("code")).toEqual([3600, 0, 0]);
    expect(byApp.get("apex")).toEqual([0, 3600, 0]);
  });

  it("keys by app row, so aliased processes share one series", () => {
    const range = { start: new Date(2026, 5, 8), end: new Date(2026, 5, 11) };
    const byApp = dailySecondsByApp(
      [sess(T0 + 3600, T0 + 7200, "time.exe"), sess(T0 + 7200, T0 + 9000, "time-tracker.exe")],
      range,
      { "time.exe": "Time", "time-tracker.exe": "Time" },
    );
    expect([...byApp.keys()]).toEqual(["time"]);
    expect(byApp.get("time")).toEqual([5400, 0, 0]);
  });
});

describe("splitAtMidnights", () => {
  it("splits a session crossing midnight", () => {
    const start = T0 + 23 * 3600 + 30 * 60; // 23:30 Mon
    const chunks = splitAtMidnights(start, start + 3600); // -> 00:30 Tue
    expect(chunks).toHaveLength(2);
    expect(chunks[0].endSec - chunks[0].startSec).toBe(1800);
    expect(chunks[1].endSec - chunks[1].startSec).toBe(1800);
    expect(dayKey(chunks[0].dayStart)).toBe("2026-06-08");
    expect(dayKey(chunks[1].dayStart)).toBe("2026-06-09");
  });
});

describe("rollingMean", () => {
  it("averages a trailing window", () => {
    expect(rollingMean([2, 4, 6], 7)).toEqual([2, 3, 4]);
    expect(rollingMean([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });
});
