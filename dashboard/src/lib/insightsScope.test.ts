import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";
import { windowGroupKey } from "./entityIdentity";
import {
  BREAK_NEIGHBOR_NAME,
  parentScope,
  scopeCandidates,
  scopeKey,
  scopeMatcher,
  scopeRuns,
  scopeTransitions,
  searchScopeCandidates,
  summarizeScope,
  topScopeWindows,
  type InsightsScope,
  type ScopeContext,
} from "./insightsScope";
import type { Session } from "./metrics";

const categories: Category[] = [
  { id: 1, name: "Focus", color: "#000", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Media", color: "#000", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Hidden", color: "#000", isProductive: false, isNeutral: true, isIgnored: true, sortOrder: 3 },
];
const rules: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 3 },
  { id: 2, matchType: "process", pattern: "notes.exe", categoryId: 1, priority: 3 },
  { id: 3, matchType: "process", pattern: "video.exe", categoryId: 2, priority: 3 },
  { id: 4, matchType: "process", pattern: "hidden.exe", categoryId: 3, priority: 3 },
  { id: 5, matchType: "domain", pattern: "youtube.com", categoryId: 2, priority: 1 },
  { id: 6, matchType: "domain", pattern: "docs.example", categoryId: 1, priority: 1 },
];
const browsers = new Set(["chrome.exe"]);
const classifier = buildClassifier(categories, rules, browsers);
const context: ScopeContext = {
  classifier,
  aliases: { "time.exe": "Time", "time-dev.exe": "Time", "youtube.com": "YouTube" },
  browserProcesses: browsers,
};

const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 5, day, hour, minute, second).getTime() / 1000;
let nextId = 1;
const make = (
  start: number,
  end: number,
  process: string,
  { title = "", domain = null, isAfk = false }: { title?: string; domain?: string | null; isAfk?: boolean } = {},
): Session => ({ id: nextId++, start, end, process, title, domain, isAfk });
const everything = { startSec: at(1, 0), endSec: at(30, 0) };
const inScopeOf = (kind: "app" | "website", key: string) =>
  scopeMatcher({ kind, key, name: key }, context);
const mediaScope: InsightsScope = { kind: "category", categoryId: 2, name: "Media" };
const chromeInMedia: InsightsScope = {
  kind: "app",
  key: "chrome",
  name: "Chrome",
  within: { categoryId: 2, name: "Media" },
};

describe("scopeMatcher", () => {
  it("follows the Insights app row, so aliased processes share one scope", () => {
    const matches = inScopeOf("app", "time");
    expect(matches(make(0, 1, "time.exe"))).toBe(true);
    expect(matches(make(0, 1, "TIME-DEV.EXE"))).toBe(true);
    expect(matches(make(0, 1, "code.exe"))).toBe(false);
  });

  it("includes a browser's website time in the browser's app scope", () => {
    const chrome = inScopeOf("app", "chrome");
    expect(chrome(make(0, 1, "chrome.exe", { domain: "youtube.com" }))).toBe(true);
    expect(chrome(make(0, 1, "chrome.exe"))).toBe(true);
  });

  it("matches a website by exact host, and only inside a browser", () => {
    const youtube = inScopeOf("website", "youtube.com");
    expect(youtube(make(0, 1, "chrome.exe", { domain: "YouTube.com" }))).toBe(true);
    expect(youtube(make(0, 1, "chrome.exe", { domain: "m.youtube.com" }))).toBe(false);
    expect(youtube(make(0, 1, "notabrowser.exe", { domain: "youtube.com" }))).toBe(false);
  });

  it("matches a category through the classifier, website rules included", () => {
    const media = scopeMatcher(mediaScope, context);
    expect(media(make(0, 1, "video.exe"))).toBe(true);
    expect(media(make(0, 1, "chrome.exe", { domain: "youtube.com" }))).toBe(true);
    expect(media(make(0, 1, "code.exe"))).toBe(false);
  });

  it("keeps an app opened from a category inside that category", () => {
    const matches = scopeMatcher(chromeInMedia, context);
    expect(matches(make(0, 1, "chrome.exe", { domain: "youtube.com" }))).toBe(true);
    expect(matches(make(0, 1, "chrome.exe", { domain: "docs.example" }))).toBe(false);
    expect(matches(make(0, 1, "chrome.exe"))).toBe(false);
    expect(matches(make(0, 1, "video.exe"))).toBe(false);
  });

  it("keeps a website opened from a category inside that category", () => {
    const matches = scopeMatcher({
      kind: "website",
      key: "youtube.com",
      name: "YouTube",
      within: { categoryId: 1, name: "Focus" },
    }, context);
    // youtube.com is Media, so none of it is Focus.
    expect(matches(make(0, 1, "chrome.exe", { domain: "youtube.com" }))).toBe(false);
  });

  it("never matches an AFK row", () => {
    expect(inScopeOf("app", "code")(make(0, 1, "code.exe", { isAfk: true }))).toBe(false);
  });
});

describe("scope identity", () => {
  it("tells a held app apart from the whole app", () => {
    expect(scopeKey(chromeInMedia)).not.toBe(scopeKey({ kind: "app", key: "chrome", name: "Chrome" }));
    expect(scopeKey(mediaScope)).toBe("category:2");
  });

  it("goes back from a held app to its category, and from anything else to nothing", () => {
    expect(parentScope(chromeInMedia)).toEqual(mediaScope);
    expect(parentScope(mediaScope)).toBeNull();
    expect(parentScope({ kind: "app", key: "chrome", name: "Chrome" })).toBeNull();
  });
});

describe("scopeRuns", () => {
  const code = inScopeOf("app", "code");
  const runs = (sessions: Session[], inScope = code) =>
    scopeRuns(sessions, inScope, classifier, everything.startSec, everything.endSec)
      .map(({ seconds }) => seconds);

  it("joins rows the tracker split on a title change", () => {
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe", { title: "a.ts" }),
      make(at(2, 9, 10), at(2, 9, 30), "code.exe", { title: "b.ts" }),
    ])).toEqual([30 * 60]);
  });

  it("carries a run across a glance at something else", () => {
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe"),
      make(at(2, 9, 10), at(2, 9, 10, 2), "explorer.exe"),
      make(at(2, 9, 10, 2), at(2, 9, 20), "code.exe"),
    ])).toEqual([1198]);
  });

  it("ends a run at a real switch", () => {
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe"),
      make(at(2, 9, 10), at(2, 9, 11), "video.exe"),
      make(at(2, 9, 11), at(2, 9, 20), "code.exe"),
    ])).toEqual([600, 540]);
  });

  it("ends a run when the reader goes idle", () => {
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe"),
      make(at(2, 9, 10), at(2, 9, 10, 5), "afk", { isAfk: true }),
      make(at(2, 9, 10, 5), at(2, 9, 20), "code.exe"),
    ])).toEqual([600, 595]);
  });

  it("treats ignored activity as unrecorded, even when it would belong to the scope", () => {
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe"),
      make(at(2, 9, 10), at(2, 9, 10, 20), "hidden.exe"),
      make(at(2, 9, 10, 20), at(2, 9, 20), "code.exe"),
    ])).toEqual([1180]);
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe"),
      make(at(2, 9, 10), at(2, 9, 12), "hidden.exe"),
      make(at(2, 9, 12), at(2, 9, 20), "code.exe"),
    ])).toEqual([600, 480]);
    const hidden = inScopeOf("app", "hidden");
    expect(runs([make(at(2, 9), at(2, 10), "hidden.exe")], hidden)).toEqual([]);
  });

  it("continues a category's run across its member apps", () => {
    const focus = scopeMatcher({ kind: "category", categoryId: 1, name: "Focus" }, context);
    expect(runs([
      make(at(2, 9), at(2, 9, 10), "code.exe"),
      make(at(2, 9, 10), at(2, 9, 20), "notes.exe"),
      make(at(2, 9, 20), at(2, 9, 25), "video.exe"),
      make(at(2, 9, 25), at(2, 9, 30), "code.exe"),
    ], focus)).toEqual([1200, 300]);
  });

  it("counts only the part of a run inside the range", () => {
    const sessions = [make(at(2, 23), at(3, 1), "code.exe")];
    expect(scopeRuns(sessions, code, classifier, at(3, 0), at(4, 0))
      .map(({ seconds }) => seconds)).toEqual([3600]);
  });

  it("orders its input rather than trusting it", () => {
    expect(runs([
      make(at(2, 9, 10), at(2, 9, 20), "code.exe"),
      make(at(2, 9), at(2, 9, 10), "code.exe"),
    ])).toEqual([1200]);
  });
});

describe("summarizeScope", () => {
  const code = inScopeOf("app", "code");

  it("reports totals, days, runs, and the previous period", () => {
    const sessions = [
      make(at(1, 9), at(1, 10), "code.exe"),
      make(at(2, 23, 30), at(3, 0, 30), "code.exe"),
      make(at(3, 9), at(3, 9, 30), "video.exe"),
      make(at(3, 9, 30), at(3, 9, 40), "afk", { isAfk: true }),
      make(at(3, 10), at(3, 10, 30), "hidden.exe"),
    ];
    const summary = summarizeScope(
      sessions,
      code,
      classifier,
      { startSec: at(2, 0), endSec: at(4, 0) },
      { startSec: at(0, 0), endSec: at(2, 0) },
    );
    const { category, ...figures } = summary;
    expect(category?.name).toBe("Focus");
    expect(figures).toEqual({
      seconds: 3600,
      // AFK and ignored time are not part of what was tracked.
      trackedSeconds: 3600 + 1800,
      parentSeconds: null,
      previousSeconds: 3600,
      // The run crosses midnight, so it was used on both days.
      daysUsed: 2,
      runs: 1,
      typicalRunSeconds: 3600,
      longestRunSeconds: 3600,
    });
  });

  it("measures a held app's share against its category", () => {
    const sessions = [
      make(at(2, 9), at(2, 10), "chrome.exe", { domain: "youtube.com" }),
      make(at(2, 10), at(2, 11), "video.exe"),
      make(at(2, 11), at(2, 13), "code.exe"),
    ];
    const summary = summarizeScope(
      sessions,
      scopeMatcher(chromeInMedia, context),
      classifier,
      everything,
      null,
      scopeMatcher(mediaScope, context),
    );
    expect(summary.seconds).toBe(3600);
    expect(summary.parentSeconds).toBe(7200);
    expect(summary.trackedSeconds).toBe(14400);
  });

  it("has no previous figure without a comparison period", () => {
    const summary = summarizeScope([], code, classifier, everything, null);
    expect(summary.previousSeconds).toBeNull();
    expect(summary.typicalRunSeconds).toBeNull();
    expect(summary.longestRunSeconds).toBeNull();
    expect(summary.category).toBeNull();
  });

  it("names the category most of an app's time resolved to", () => {
    const chrome = inScopeOf("app", "chrome");
    const summary = summarizeScope(
      [
        make(at(2, 9), at(2, 9, 10), "chrome.exe", { domain: "youtube.com" }),
        make(at(2, 10), at(2, 10, 5), "chrome.exe", { domain: "docs.example" }),
      ],
      chrome,
      classifier,
      everything,
      null,
    );
    expect(summary.category?.name).toBe("Media");
  });
});

describe("topScopeWindows", () => {
  it("groups titles the way Activity does and keeps the newest spelling", () => {
    const youtube = inScopeOf("website", "youtube.com");
    const list = topScopeWindows(
      [
        make(at(2, 9), at(2, 9, 10), "chrome.exe", { domain: "youtube.com", title: "Lecture 4" }),
        make(at(2, 10), at(2, 10, 5), "chrome.exe", { domain: "youtube.com", title: "LECTURE 4" }),
        make(at(2, 11), at(2, 11, 20), "chrome.exe", { domain: "youtube.com", title: "Trailer" }),
        make(at(2, 12), at(2, 12, 1), "chrome.exe", { domain: "youtube.com" }),
        make(at(2, 13), at(2, 14), "chrome.exe", { domain: "docs.example", title: "Elsewhere" }),
      ],
      youtube,
      context,
      everything,
      10,
    );
    expect(list.rows.map(({ key, title, seconds }) => ({ key, title, seconds }))).toEqual([
      { key: "trailer", title: "Trailer", seconds: 1200 },
      { key: "lecture 4", title: "LECTURE 4", seconds: 900 },
    ]);
    expect(list.total).toBe(2);
    expect(list.untitledSeconds).toBe(60);
  });

  it("names the Activity window each row opens", () => {
    const list = topScopeWindows(
      [
        make(at(2, 9), at(2, 9, 10), "time.exe", { title: "Time" }),
        make(at(2, 10), at(2, 10, 30), "time-dev.exe", { title: "Time" }),
        make(at(2, 11), at(2, 11, 5), "chrome.exe", { domain: "youtube.com", title: "Trailer" }),
      ],
      (session) => session.process !== "code.exe",
      context,
      everything,
      10,
    );
    // An alias's processes are separate entities in Activity: the row opens
    // the one most of its time was in. Browser time opens the website.
    expect(list.rows.map(({ entityId, activityKey }) => ({ entityId, activityKey }))).toEqual([
      { entityId: "app:time-dev.exe", activityKey: windowGroupKey("app:time-dev.exe", "time") },
      { entityId: "website:youtube.com", activityKey: windowGroupKey("website:youtube.com", "trailer") },
    ]);
  });
});

describe("scopeTransitions", () => {
  const code = inScopeOf("app", "code");

  it("tallies what came right before and after each run", () => {
    const sessions = [
      make(at(2, 8, 50), at(2, 9), "slack.exe"),
      make(at(2, 9), at(2, 9, 30), "code.exe"),
      make(at(2, 9, 30), at(2, 9, 40), "chrome.exe", { domain: "youtube.com" }),
      make(at(2, 9, 40), at(2, 10), "code.exe"),
      make(at(2, 10), at(2, 10, 10), "afk", { isAfk: true }),
      make(at(2, 13), at(2, 13, 30), "code.exe"),
      make(at(2, 13, 30), at(2, 13, 45), "slack.exe"),
    ];
    const transitions = scopeTransitions(sessions, code, context, everything);
    const tally = (side: typeof transitions.before) =>
      side.map(({ name, kind, runs, category }) => ({ name, kind, runs, category: category?.name ?? null }));
    expect(tally(transitions.before)).toEqual([
      { name: BREAK_NEIGHBOR_NAME, kind: "break", runs: 1, category: null },
      { name: "Slack", kind: "app", runs: 1, category: null },
      { name: "YouTube", kind: "website", runs: 1, category: "Media" },
    ]);
    expect(tally(transitions.after)).toEqual([
      { name: BREAK_NEIGHBOR_NAME, kind: "break", runs: 1, category: null },
      { name: "Slack", kind: "app", runs: 1, category: null },
      { name: "YouTube", kind: "website", runs: 1, category: "Media" },
    ]);
    expect(transitions.beforeRuns).toBe(3);
    expect(transitions.afterRuns).toBe(3);
  });

  it("leaves out a side nothing was recorded on", () => {
    const transitions = scopeTransitions(
      [make(at(2, 9), at(2, 10), "code.exe")],
      code,
      context,
      everything,
    );
    expect(transitions).toEqual({ before: [], after: [], beforeRuns: 0, afterRuns: 0 });
  });
});

describe("scopeCandidates", () => {
  const sessions = [
    make(at(2, 9), at(2, 11), "code.exe"),
    make(at(2, 11), at(2, 12), "time.exe"),
    make(at(2, 12), at(2, 12, 30), "time-dev.exe"),
    make(at(2, 13), at(2, 13, 45), "chrome.exe", { domain: "youtube.com" }),
    make(at(2, 14), at(2, 14, 10), "chrome.exe"),
    make(at(2, 15), at(2, 16), "hidden.exe"),
    make(at(2, 16), at(2, 17), "afk", { isAfk: true }),
    make(at(9, 9), at(9, 10), "notes.exe"),
  ];
  const range = { startSec: at(1, 0), endSec: at(8, 0) };
  const candidates = scopeCandidates(sessions, context, range);
  const summary = (list: typeof candidates.apps) =>
    list.map(({ scope, seconds, category }) => [scopeKey(scope), scope.name, seconds, category?.name ?? null]);

  it("offers what has time in range, the way the ranked lists name it", () => {
    expect(summary(candidates.categories)).toEqual([
      ["category:1", "Focus", 7200, "Focus"],
      ["category:2", "Media", 2700, "Media"],
    ]);
    expect(summary(candidates.apps)).toEqual([
      ["app:code", "Code", 7200, "Focus"],
      ["app:time", "Time", 5400, null],
      ["app:chrome", "Chrome", 3300, "Media"],
    ]);
    expect(summary(candidates.websites)).toEqual([
      ["website:youtube.com", "YouTube", 2700, "Media"],
    ]);
  });

  it("searches names and hosts, and caps each section", () => {
    const limits = { categories: 5, apps: 5, websites: 5 };
    expect(searchScopeCandidates(candidates, "TIME", limits).apps.map((c) => c.scope.name)).toEqual(["Time"]);
    expect(searchScopeCandidates(candidates, "youtube.com", limits).websites).toHaveLength(1);
    expect(searchScopeCandidates(candidates, "nothing like this", limits)).toEqual({
      categories: [],
      apps: [],
      websites: [],
    });
    expect(searchScopeCandidates(candidates, "  ", { categories: 1, apps: 2, websites: 0 }))
      .toEqual({
        categories: candidates.categories.slice(0, 1),
        apps: candidates.apps.slice(0, 2),
        websites: [],
      });
  });
});
