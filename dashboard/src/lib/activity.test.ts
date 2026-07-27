import { describe, expect, it } from "vitest";

import {
  GROUP_SESSION_SAMPLE,
  buildActivityIndex,
  packActivitySource,
  queryActivityIndex,
  unpackActivitySource,
  type ActivityQuery,
  type ActivitySource,
} from "./activity";
import type { Category, Rule } from "./classify";

const categories: Category[] = [
  { id: 1, name: "Focus", color: "#00f", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Media", color: "#f00", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Ignored", color: "#777", isProductive: false, isNeutral: false, isIgnored: true, sortOrder: 3 },
];

const rules: Rule[] = [
  { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 3 },
  { id: 3, matchType: "domain", pattern: "youtube.com", categoryId: 2, priority: 1 },
  { id: 4, matchType: "title", pattern: "mail", categoryId: 2, priority: 2 },
  { id: 5, matchType: "process", pattern: "shell.exe", categoryId: 3, priority: 3 },
];

const source: ActivitySource = {
  categories,
  rules,
  browserProcesses: ["chrome.exe"],
  aliases: { "code.exe": "Editor" },
  sessions: [
    { id: 1, start: 10, end: 40, process: "code.exe", title: "Project", domain: null, isAfk: false },
    { id: 2, start: 40, end: 70, process: "chrome.exe", title: "Video", domain: "youtube.com", isAfk: false },
    { id: 3, start: 70, end: 100, process: "chrome.exe", title: "Inbox - mail", domain: "example.com", isAfk: false },
    { id: 4, start: 100, end: 130, process: "chrome.exe", title: "Docs", domain: "example.com", isAfk: false },
    { id: 5, start: 130, end: 160, process: "unknown.exe", title: "Secret note", domain: null, isAfk: false },
    { id: 6, start: 160, end: 190, process: "shell.exe", title: "", domain: null, isAfk: false },
    { id: 7, start: 190, end: 220, process: "code.exe", title: "", domain: null, isAfk: true },
  ],
};

const baseQuery: ActivityQuery = {
  startSec: 0,
  endSec: 300,
  search: "",
  typeFilter: "all",
  classificationFilter: "all",
  sort: "seconds",
  direction: "desc",
  entityOffset: 0,
  entityLimit: 100,
  windowOffset: 0,
  windowLimit: 50,
};

describe("Activity index", () => {
  it("splits browser websites, excludes AFK, retains ignored, and never thresholds", () => {
    const result = queryActivityIndex(buildActivityIndex(source), baseQuery);
    expect(result.catalog.rows.map((row) => row.id)).toEqual([
      "website:example.com",
      "app:code.exe",
      "app:shell.exe",
      "app:unknown.exe",
      "website:youtube.com",
    ]);
    expect(result.catalog.rows.find((row) => row.id === "app:code.exe")?.displayName).toBe("Editor");
    expect(result.catalog.rows.find((row) => row.id === "app:shell.exe")?.status).toBe("ignored");
  });

  it("distinguishes uncategorized, partial, and mixed classifications", () => {
    const result = queryActivityIndex(buildActivityIndex(source), baseQuery);
    expect(result.catalog.rows.find((row) => row.id === "app:unknown.exe")?.status).toBe("uncategorized");
    expect(result.catalog.rows.find((row) => row.id === "app:code.exe")?.status).toBe("single");
    expect(result.catalog.rows.find((row) => row.id === "app:shell.exe")?.status).toBe("ignored");
    const example = result.catalog.rows.find((row) => row.id === "website:example.com");
    expect(example?.status).toBe("partial");

    const mixed = buildActivityIndex({
      ...source,
      rules: [...rules, { id: 6, matchType: "process", pattern: "chrome.exe", categoryId: 1, priority: 3 }],
    });
    expect(queryActivityIndex(mixed, baseQuery).catalog.rows.find((row) => row.id === "website:example.com")?.status).toBe("mixed");
  });

  it("treats an entity as ignored when every applied category is excluded", () => {
    const anotherIgnored = { ...categories[2], id: 4, name: "Private" };
    const index = buildActivityIndex({
      ...source,
      categories: [...categories, anotherIgnored],
      rules: [
        ...rules,
        { id: 7, matchType: "title", pattern: "secret", categoryId: 4, priority: 2 },
        { id: 8, matchType: "process", pattern: "chrome.exe", categoryId: 3, priority: 3 },
      ],
      sessions: [
        { id: 20, start: 0, end: 10, process: "chrome.exe", title: "ordinary", domain: null, isAfk: false },
        { id: 21, start: 10, end: 20, process: "chrome.exe", title: "secret", domain: null, isAfk: false },
      ],
    });
    const entity = queryActivityIndex(index, baseQuery).catalog.rows[0];
    expect(entity.categories).toHaveLength(2);
    expect(entity.status).toBe("ignored");
  });

  it("clips totals to the shared range and sorts deterministically", () => {
    const result = queryActivityIndex(buildActivityIndex(source), {
      ...baseQuery,
      startSec: 20,
      endSec: 55,
    });
    expect(result.catalog.rows.map((row) => [row.id, row.seconds])).toEqual([
      ["website:youtube.com", 15],
      ["app:code.exe", 20],
    ].sort((left, right) => Number(right[1]) - Number(left[1])));
  });

  it("paginates deterministically and searches aliases, cleaned names, and raw names", () => {
    const index = buildActivityIndex(source);
    const paged = queryActivityIndex(index, {
      ...baseQuery,
      sort: "name",
      direction: "asc",
      entityLimit: 2,
    });
    expect(paged.catalog.total).toBe(5);
    expect(paged.catalog.rows).toHaveLength(2);
    expect(queryActivityIndex(index, { ...baseQuery, search: "editor" }).catalog.total).toBe(1);
    expect(queryActivityIndex(index, { ...baseQuery, search: "code" }).catalog.total).toBe(1);
    expect(queryActivityIndex(index, { ...baseQuery, search: "code.exe" }).catalog.total).toBe(1);
  });

  it("narrows the catalog in place and lists window titles beside it", () => {
    const index = buildActivityIndex(source);
    const idle = queryActivityIndex(index, baseQuery);
    expect(idle.windowMatches).toBeNull();

    const editor = queryActivityIndex(index, { ...baseQuery, search: "editor" });
    expect(editor.catalog.rows.map((row) => row.id)).toEqual(["app:code.exe"]);
    expect(editor.windowMatches?.total).toBe(0);

    const title = queryActivityIndex(index, { ...baseQuery, search: "mail" });
    expect(title.windowMatches?.rows.map((row) => row.title)).toEqual(["Inbox - mail"]);
    expect(title.windowMatches?.rows[0].sessionIds).toEqual([3]);
    expect(title.windowMatches?.rows[0].winningRuleType).toBe("title");

    const website = queryActivityIndex(index, { ...baseQuery, search: "youtube" });
    expect(website.catalog.rows.map((row) => row.id)).toEqual(["website:youtube.com"]);
  });

  it("keeps one identity list for both kinds, ordered by the chosen sort", () => {
    const index = buildActivityIndex(source);
    // "e" is in both an app's name and a website's, so a merged list has to
    // interleave them rather than emit one kind and then the other.
    const found = queryActivityIndex(index, { ...baseQuery, search: "e", sort: "seconds", direction: "desc" });
    const kinds = found.catalog.rows.map((row) => row.kind);
    expect(kinds).toContain("app");
    expect(kinds).toContain("website");
    const seconds = found.catalog.rows.map((row) => row.seconds);
    expect(seconds).toEqual([...seconds].sort((left, right) => right - left));
  });

  it("matches window titles regardless of the type filter", () => {
    const index = buildActivityIndex(source);
    // Session 3's title lives on a browser session filed under a website, so an
    // apps-only filter would drop it — the one row the search was for.
    const appsOnly = queryActivityIndex(index, { ...baseQuery, search: "mail", typeFilter: "app" });
    expect(appsOnly.catalog.total).toBe(0);
    expect(appsOnly.windowMatches?.rows[0].sessionIds).toEqual([3]);
  });

  it("collapses repeat visits to one window into a single row", () => {
    // The shape a real database takes: one window returned to over and over,
    // each visit its own storage row. Read row by row it is 4 results; read as
    // a thing it is one window worth 70 seconds.
    const index = buildActivityIndex({
      ...source,
      sessions: [
        { id: 1, start: 0, end: 30, process: "obsidian.exe", title: "Skill Tree — roadmap", domain: null, isAfk: false },
        { id: 2, start: 40, end: 50, process: "obsidian.exe", title: "Skill Tree — roadmap", domain: null, isAfk: false },
        { id: 3, start: 60, end: 65, process: "obsidian.exe", title: "Groceries", domain: null, isAfk: false },
        { id: 4, start: 70, end: 100, process: "obsidian.exe", title: "Skill Tree — roadmap", domain: null, isAfk: false },
      ],
    });
    const found = queryActivityIndex(index, { ...baseQuery, search: "e" });
    const groups = found.windowMatches!;
    expect(groups.total).toBe(2);
    expect(groups.sessionTotal).toBe(4);
    const [first, second] = groups.rows;
    // Heaviest window first, not most recent.
    expect(first.title).toBe("Skill Tree — roadmap");
    expect(first.sessionCount).toBe(3);
    expect(first.seconds).toBe(70);
    expect(first.sessionIds).toEqual([4, 2, 1]); // newest first, as listed
    expect(first.firstSeen).toBe(0);
    expect(first.lastSeen).toBe(100);
    expect(second.title).toBe("Groceries");
  });

  it("separates identical titles belonging to different identities", () => {
    const index = buildActivityIndex({
      ...source,
      browserProcesses: ["chrome.exe"],
      sessions: [
        { id: 1, start: 0, end: 30, process: "chrome.exe", title: "Inbox", domain: "mail.com", isAfk: false },
        { id: 2, start: 40, end: 70, process: "outlook.exe", title: "Inbox", domain: null, isAfk: false },
      ],
    });
    const groups = queryActivityIndex(index, { ...baseQuery, search: "inbox" }).windowMatches!;
    expect(groups.total).toBe(2);
    expect(new Set(groups.rows.map((row) => row.entityId))).toEqual(
      new Set(["website:mail.com", "app:outlook.exe"]),
    );
  });

  it("pages by title, so one busy window costs one row", () => {
    const sessions = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      start: i * 10,
      end: i * 10 + 5,
      process: "claude.exe",
      title: "Claude",
      domain: null,
      isAfk: false,
    }));
    const index = buildActivityIndex({ ...source, sessions });
    const groups = queryActivityIndex(index, {
      ...baseQuery,
      endSec: 500, // the fixture runs past baseQuery's window
      search: "claude",
      windowLimit: 5,
    }).windowMatches!;
    expect(groups.rows).toHaveLength(1);
    expect(groups.total).toBe(1);
    expect(groups.sessionTotal).toBe(40);
    // Every visit is selectable even though only a sample is carried.
    expect(groups.rows[0].sessionIds).toHaveLength(40);
    expect(groups.rows[0].sessions).toHaveLength(GROUP_SESSION_SAMPLE);
  });

  it("marks a group mixed when its sessions do not classify alike", () => {
    const index = buildActivityIndex({
      ...source,
      sessions: [
        { id: 1, start: 0, end: 30, process: "code.exe", title: "Project", domain: null, isAfk: false },
        // Same window, corrected by hand to a different category.
        { id: 2, start: 40, end: 70, process: "code.exe", title: "Project", domain: null, isAfk: false, categoryOverrideId: 2, isCorrected: true },
      ],
    });
    const group = queryActivityIndex(index, { ...baseQuery, search: "project" }).windowMatches!.rows[0];
    expect(group.mixed).toBe(true);
    expect(group.categoryName).toBeNull();
    expect(group.winningRulePattern).toBeNull();
  });

  it("returns both forms of Mixed, since they share the word on screen", () => {
    const index = buildActivityIndex(source);
    const mixed = queryActivityIndex(index, { ...baseQuery, classificationFilter: "mixed" });
    const statuses = new Set(mixed.catalog.rows.map((row) => row.status));
    // example.com is partly uncategorized; the filter must not drop it just
    // because its status is spelled "partial" internally.
    expect(mixed.catalog.rows.map((row) => row.id)).toContain("website:example.com");
    for (const status of statuses) expect(["mixed", "partial"]).toContain(status);
  });

  it("filters Uncategorized without hiding low-duration identities", () => {
    const index = buildActivityIndex(source);
    const result = queryActivityIndex(index, {
      ...baseQuery,
      classificationFilter: "uncategorized",
    });
    expect(result.catalog.rows.map((row) => row.id)).toEqual([
      "website:example.com",
      "app:unknown.exe",
    ]);
    expect(result.uncategorized).toEqual({ entities: 2, seconds: 60 });
  });

  it("reports a rule as applied only while something in history matches it", () => {
    const applied = queryActivityIndex(buildActivityIndex(source), baseQuery).appliedRuleIds;
    expect([...applied].sort()).toEqual([1, 3, 4, 5]);

    const unmatched = buildActivityIndex({
      ...source,
      rules: [...rules, { id: 9, matchType: "process", pattern: "never.exe", categoryId: 1, priority: 3 }],
    });
    expect(queryActivityIndex(unmatched, baseQuery).appliedRuleIds).not.toContain(9);
  });

  it("groups an entity's windows with provenance, paging by title", () => {
    const result = queryActivityIndex(buildActivityIndex(source), {
      ...baseQuery,
      selectedEntityId: "website:example.com",
      detailLimit: 1,
    });
    expect(result.selectedEntity?.sessionCount).toBe(2);
    expect(result.detailTotal).toBe(2);
    // Two distinct titles behind two sessions; the limit pages titles.
    expect(result.detailGroups.total).toBe(2);
    expect(result.detailGroups.sessionTotal).toBe(2);
    expect(result.detailGroups.rows).toHaveLength(1);
    // Titles are no longer withheld until searched — the drawer decides whether
    // to show them, and the query always carries them.
    expect(result.detailGroups.rows[0].title).not.toBe("");
    expect(result.selectedEntity?.rules.map((rule) => rule.ruleId)).toEqual([4]);

    const filtered = queryActivityIndex(buildActivityIndex(source), {
      ...baseQuery,
      selectedEntityId: "website:example.com",
      detailSearch: "mail",
    });
    expect(filtered.detailGroups.rows.map((group) => [group.title, group.sessionIds])).toEqual([
      ["Inbox - mail", [3]],
    ]);
  });

  it("keeps a browser app mixed when a Window rule overrides its App default", () => {
    const index = buildActivityIndex({
      categories,
      browserProcesses: ["chrome.exe"],
      aliases: {},
      rules: [
        { id: 10, matchType: "process", pattern: "chrome.exe", categoryId: 1, priority: 3 },
        { id: 11, matchType: "title", pattern: "video", categoryId: 2, priority: 2 },
      ],
      sessions: [
        { id: 30, start: 0, end: 10, process: "chrome.exe", title: "Blank tab", domain: null, isAfk: false },
        { id: 31, start: 10, end: 20, process: "chrome.exe", title: "Video player", domain: null, isAfk: false },
      ],
    });
    const entity = queryActivityIndex(index, baseQuery).catalog.rows[0];
    expect(entity.id).toBe("app:chrome.exe");
    expect(entity.status).toBe("mixed");
    expect(entity.rules.map((rule) => rule.matchType)).toEqual(["process", "title"]);
  });

  it("round-trips packed worker transport", () => {
    expect(unpackActivitySource(packActivitySource(source))).toEqual({
      ...source,
      sessions: source.sessions.map((session) => ({
        ...session,
        categoryOverrideId: null,
        isCorrected: false,
      })),
    });
  });

  it("preserves corrections through worker transport and applies override precedence", () => {
    const corrected: ActivitySource = {
      ...source,
      sessions: [{ ...source.sessions[0], categoryOverrideId: 2, isCorrected: true }],
    };
    const unpacked = unpackActivitySource(packActivitySource(corrected));
    const row = queryActivityIndex(buildActivityIndex(unpacked), baseQuery).catalog.rows[0];
    expect(row.categories[0].name).toBe("Media");
    expect(buildActivityIndex(unpacked).sessions[0].classificationSource).toBe("session_override");
    expect(buildActivityIndex(unpacked).sessions[0].isCorrected).toBe(true);
  });
});

describe("Activity noise filtering", () => {
  const policy = { mode: "utilities", maxSeconds: 120, maxSessions: 3 } as const;
  const index = buildActivityIndex(source);

  it("hides rare items from the catalog while counting them for the header", () => {
    const plain = queryActivityIndex(index, baseQuery);
    expect(plain.noiseHidden).toBe(0);
    expect(plain.catalog.rows.map((row) => row.id)).toContain("app:unknown.exe");

    const filtered = queryActivityIndex(index, { ...baseQuery, noise: policy });
    expect(filtered.noiseHidden).toBe(1);
    expect(filtered.catalog.rows.map((row) => row.id)).not.toContain("app:unknown.exe");
    expect(filtered.catalog.total).toBe(plain.catalog.total - 1);
  });

  it("leaves hidden rows out of the uncategorized count the header shows", () => {
    // Counting what the catalog does not list makes the number and the list
    // disagree, and filtered clutter is never worth triaging.
    expect(queryActivityIndex(index, baseQuery).uncategorized).toEqual({ entities: 2, seconds: 60 });

    const filtered = queryActivityIndex(index, { ...baseQuery, noise: policy });
    expect(filtered.catalog.rows.map((row) => row.id)).not.toContain("app:unknown.exe");
    expect(filtered.uncategorized).toEqual({ entities: 1, seconds: 30 });

    // Revealing hidden rows is a view toggle, not a change to what counts.
    const shown = queryActivityIndex(index, { ...baseQuery, noise: policy, includeNoise: true });
    expect(shown.uncategorized).toEqual(filtered.uncategorized);
  });

  it("shows hidden rows tagged when includeNoise is set", () => {
    const shown = queryActivityIndex(index, { ...baseQuery, noise: policy, includeNoise: true });
    expect(shown.noiseHidden).toBe(1);
    expect(shown.catalog.rows.find((row) => row.id === "app:unknown.exe")?.noise).toBe("one_off");
    expect(shown.catalog.rows.find((row) => row.id === "app:code.exe")?.noise).toBeNull();
  });

  it("lets search reach past the filter", () => {
    const found = queryActivityIndex(index, { ...baseQuery, noise: policy, search: "unknown" });
    expect(found.noiseHidden).toBe(0);
    expect(found.catalog.rows.map((row) => row.id)).toEqual(["app:unknown.exe"]);
  });

  it("hides installers by name no matter how long they ran", () => {
    const utilityIndex = buildActivityIndex({
      ...source,
      sessions: [
        { id: 40, start: 0, end: 1800, process: "AmdSoftwareInstaller.exe", title: "", domain: null, isAfk: false },
        { id: 41, start: 1800, end: 3600, process: "code.exe", title: "Project", domain: null, isAfk: false },
      ],
    });
    const query = { ...baseQuery, endSec: 4000, noise: policy };
    expect(queryActivityIndex(utilityIndex, query).catalog.rows.map((row) => row.id)).toEqual([
      "app:code.exe",
    ]);
    expect(
      queryActivityIndex(utilityIndex, { ...query, noise: { ...policy, mode: "one_off" } }).catalog.rows,
    ).toHaveLength(2);
  });

  it("uses all-history totals so the selected range cannot make a recurring item rare", () => {
    const recurring = buildActivityIndex({
      ...source,
      rules: [],
      sessions: [
        { id: 50, start: 10, end: 20, process: "timer.exe", title: "", domain: null, isAfk: false },
        { id: 51, start: 40, end: 50, process: "timer.exe", title: "", domain: null, isAfk: false },
        { id: 52, start: 70, end: 80, process: "timer.exe", title: "", domain: null, isAfk: false },
        { id: 53, start: 100, end: 110, process: "timer.exe", title: "", domain: null, isAfk: false },
      ],
    });
    const narrow = queryActivityIndex(recurring, {
      ...baseQuery,
      startSec: 95,
      endSec: 120,
      noise: policy,
    });

    expect(narrow.catalog.rows.map((row) => row.id)).toEqual(["app:timer.exe"]);
    expect(narrow.catalog.rows[0].sessionCount).toBe(1);
    expect(narrow.catalog.rows[0].noise).toBeNull();
  });
});

/** A local wall-clock instant, so sessions built from it fall on the intended
 *  date in every timezone the suite runs under. */
function localSec(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime() / 1000;
}

describe("Days seen", () => {
  const spanning: ActivitySource = {
    ...source,
    rules: [],
    sessions: [
      // Two visits on one day, then one the next: three sessions, two days.
      { id: 60, start: localSec(2026, 3, 10, 9), end: localSec(2026, 3, 10, 10), process: "app.exe", title: "", domain: null, isAfk: false },
      { id: 61, start: localSec(2026, 3, 10, 14), end: localSec(2026, 3, 10, 15), process: "app.exe", title: "", domain: null, isAfk: false },
      { id: 62, start: localSec(2026, 3, 11, 9), end: localSec(2026, 3, 11, 10), process: "app.exe", title: "", domain: null, isAfk: false },
      // One session across midnight is activity on both dates.
      { id: 63, start: localSec(2026, 3, 12, 23), end: localSec(2026, 3, 13, 1), process: "night.exe", title: "", domain: null, isAfk: false },
    ],
  };
  const wideQuery: ActivityQuery = {
    ...baseQuery,
    startSec: localSec(2026, 3, 1),
    endSec: localSec(2026, 3, 20),
  };

  it("counts distinct local days rather than sessions", () => {
    const result = queryActivityIndex(buildActivityIndex(spanning), wideQuery);
    const app = result.catalog.rows.find((row) => row.id === "app:app.exe");
    expect(app?.sessionCount).toBe(3);
    expect(app?.daysSeen).toBe(2);
  });

  it("credits both dates a session spans across midnight", () => {
    const result = queryActivityIndex(buildActivityIndex(spanning), wideQuery);
    expect(result.catalog.rows.find((row) => row.id === "app:night.exe")?.daysSeen).toBe(2);
  });

  it("counts only days inside the range, and sorts by them", () => {
    const result = queryActivityIndex(buildActivityIndex(spanning), {
      ...wideQuery,
      startSec: localSec(2026, 3, 11, 0),
      sort: "days",
      direction: "desc",
    });
    expect(result.catalog.rows.map((row) => [row.id, row.daysSeen])).toEqual([
      ["app:night.exe", 2],
      ["app:app.exe", 1],
    ]);
  });
});

describe("New items", () => {
  const history: ActivitySource = {
    ...source,
    rules: [],
    sessions: [
      { id: 70, start: 100, end: 200, process: "old.exe", title: "", domain: null, isAfk: false },
      { id: 71, start: 1000, end: 1100, process: "old.exe", title: "", domain: null, isAfk: false },
      { id: 72, start: 1000, end: 1100, process: "fresh.exe", title: "", domain: null, isAfk: false },
    ],
  };

  it("marks only what first appeared inside the range", () => {
    const result = queryActivityIndex(buildActivityIndex(history), {
      ...baseQuery,
      startSec: 900,
      endSec: 2000,
    });
    expect(result.catalog.rows.find((row) => row.id === "app:fresh.exe")?.isNew).toBe(true);
    expect(result.catalog.rows.find((row) => row.id === "app:old.exe")?.isNew).toBe(false);
  });

  it("marks nothing when the range reaches back to the first session ever", () => {
    const result = queryActivityIndex(buildActivityIndex(history), {
      ...baseQuery,
      startSec: 0,
      endSec: 2000,
    });
    expect(result.catalog.rows.every((row) => !row.isNew)).toBe(true);
  });
});

describe("Range totals", () => {
  it("sums every recorded second in range, filters and hidden rows included", () => {
    const result = queryActivityIndex(buildActivityIndex(source), {
      ...baseQuery,
      typeFilter: "app",
      classificationFilter: "uncategorized",
    });
    const shown = result.catalog.rows.reduce((total, row) => total + row.seconds, 0);
    // Four non-AFK app sessions plus two website ones, 30s each.
    expect(result.totalSeconds).toBe(180);
    expect(shown).toBeLessThan(result.totalSeconds);
  });

  it("scales bars to the heaviest admitted row, not to the loaded page", () => {
    const index = buildActivityIndex(source);
    const full = queryActivityIndex(index, baseQuery);
    // One row on screen or all of them, the bar scale has to be identical —
    // otherwise Load more silently redraws every bar above it.
    const firstPage = queryActivityIndex(index, { ...baseQuery, entityLimit: 1 });
    expect(firstPage.catalog.rows).toHaveLength(1);
    expect(firstPage.maxSeconds).toBe(full.maxSeconds);
    expect(full.maxSeconds).toBe(
      Math.max(...full.catalog.rows.map((row) => row.seconds)),
    );
  });

  it("rescales when a filter changes which rows are admitted", () => {
    const index = buildActivityIndex(source);
    const websites = queryActivityIndex(index, { ...baseQuery, typeFilter: "website" });
    expect(websites.maxSeconds).toBe(
      Math.max(...websites.catalog.rows.map((row) => row.seconds)),
    );
    // The range total is a property of the range, so it does not move with the
    // filter the way the bar scale does.
    expect(websites.totalSeconds).toBe(queryActivityIndex(index, baseQuery).totalSeconds);
  });

  it("scopes the uncategorized count to the type filter but not the classification", () => {
    const index = buildActivityIndex(source);
    const all = queryActivityIndex(index, { ...baseQuery, classificationFilter: "mixed" });
    // Surviving a different classification filter is the point: the count
    // labels the option that would apply its own.
    expect(all.uncategorized.entities).toBe(2);
    const websitesOnly = queryActivityIndex(index, { ...baseQuery, typeFilter: "website" });
    expect(websitesOnly.uncategorized.entities).toBe(1);
  });
});
