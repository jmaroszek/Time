import { describe, expect, it } from "vitest";

import {
  GROUP_SESSION_SAMPLE,
  TRIAGE_VISIBLE,
  backlogOnlyQuery,
  bucketDailyUsage,
  buildActivityIndex,
  currentActivitySessionIds,
  packActivitySource,
  queryActivityIndex,
  resolveSelectedWindow,
  restrictActivitySessionIds,
  unpackActivitySource,
  type ActivityQuery,
  type ActivityQueryResult,
  type ActivitySource,
  type ActivityTitleGroup,
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
  windowSort: "seconds",
  windowDirection: "desc",
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
    expect({ apps: result.catalog.apps, websites: result.catalog.websites }).toEqual({
      apps: 3,
      websites: 2,
    });
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

  it("reads the unclassified backlog from all history, not the queried range", () => {
    const index = buildActivityIndex(source);
    // A window holding none of the sessions. The catalog empties; a backlog
    // that emptied with it would be a to-do list nobody could ever finish.
    const narrow = queryActivityIndex(index, { ...baseQuery, startSec: 0, endSec: 5 });
    expect(narrow.catalog.rows).toEqual([]);
    expect(narrow.triage.items.map((item) => item.id)).toEqual(["app:unknown.exe"]);
    expect(narrow.triage).toMatchObject({ total: 1, seconds: 30 });
    expect(narrow.triage.items[0].seconds).toBe(30);
  });

  it("refuses partly classified rows that the Uncategorized filter admits", () => {
    const index = buildActivityIndex(source);
    // example.com has one categorized visit and one nothing matched, so the
    // filter lists it while a single assignment could not clear it — and a row
    // that survives being acted on is worse than one never offered.
    const listed = queryActivityIndex(index, {
      ...baseQuery,
      classificationFilter: "uncategorized",
    });
    expect(listed.catalog.rows.map((row) => row.id)).toContain("website:example.com");
    expect(listed.triage.items.map((item) => item.id)).not.toContain("website:example.com");
  });

  it("keeps the noise fold whatever the catalog has been asked to show", () => {
    const index = buildActivityIndex(source);
    const shown = queryActivityIndex(index, {
      ...baseQuery,
      noise: { mode: "one_off", maxSeconds: 120, maxSessions: 1 },
      includeNoise: true,
    });
    // Every folded row is uncategorized by construction, so honouring "Show"
    // here would not widen the backlog — it would replace it with one-offs.
    expect(shown.catalog.rows.map((row) => row.id)).toContain("app:unknown.exe");
    expect(shown.triage.items).toEqual([]);
    expect(shown.triage).toMatchObject({ total: 0, seconds: 0 });
  });

  it("answers to none of the filters the controls below it set", () => {
    const index = buildActivityIndex(source);
    const filtered = queryActivityIndex(index, {
      ...baseQuery,
      search: "code",
      typeFilter: "website",
      classificationFilter: "category:1",
    });
    expect(filtered.triage.items.map((item) => item.id)).toEqual(["app:unknown.exe"]);
  });

  it("ranks the backlog by time, caps the list, and counts past the cap", () => {
    const pending: ActivitySource = {
      categories,
      rules: [],
      browserProcesses: [],
      aliases: {},
      // Seven unclassified apps at 60s, 120s, … 420s.
      sessions: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        start: i * 1000,
        end: i * 1000 + (i + 1) * 60,
        process: `app${i + 1}.exe`,
        title: "",
        domain: null,
        isAfk: false,
      })),
    };
    const result = queryActivityIndex(buildActivityIndex(pending), { ...baseQuery, endSec: 10_000 });
    expect(result.triage.items).toHaveLength(TRIAGE_VISIBLE);
    expect(result.triage.items.map((item) => item.id)).toEqual([
      "app:app7.exe",
      "app:app6.exe",
      "app:app5.exe",
      "app:app4.exe",
      "app:app3.exe",
    ]);
    // The counts describe the whole backlog, not the five rows shown.
    expect(result.triage).toMatchObject({ total: 7, seconds: 60 + 120 + 180 + 240 + 300 + 360 + 420 });
  });

  it("reports the whole backlog from the badge's empty-range query", () => {
    const index = buildActivityIndex(source);
    const badge = queryActivityIndex(index, backlogOnlyQuery());
    // The empty range is the point: nothing range-scoped is aggregated, so the
    // badge pays for no catalog, while the backlog it needs comes out whole.
    expect(badge.catalog.rows).toEqual([]);
    expect(badge.totalSeconds).toBe(0);
    expect(badge.triage).toMatchObject({ total: 1, seconds: 30 });
    expect(badge.triage.items.map((item) => item.id)).toEqual(["app:unknown.exe"]);
    // And it carries the noise policy, so the badge cannot light up over rows
    // the section it points at would refuse to list.
    const folded = queryActivityIndex(
      index,
      backlogOnlyQuery({ mode: "one_off", maxSeconds: 120, maxSessions: 1 }),
    );
    expect(folded.triage).toMatchObject({ total: 0, seconds: 0 });
  });

  it("empties the backlog once a rule claims the last unclassified row", () => {
    const index = buildActivityIndex({
      ...source,
      rules: [...rules, { id: 9, matchType: "process", pattern: "unknown.exe", categoryId: 1, priority: 3 }],
    });
    expect(queryActivityIndex(index, baseQuery).triage).toEqual({
      items: [],
      pendingApps: [],
      total: 0,
      seconds: 0,
      // example.com keeps 30s the title rule never claimed. The list is empty
      // and the backlog is not, which is the whole reason this field exists.
      residual: { entities: 1, seconds: 30 },
    });
  });

  // The section excludes partly-classified rows, so the residue they carry is
  // the one way for uncategorized time to be invisible to every count the tab
  // keeps. Reported rather than listed — see triageSummary for why.
  it("reports uncategorized time on partly-classified rows the list omits", () => {
    const { triage } = queryActivityIndex(buildActivityIndex(source), baseQuery);
    // Uncategorized in full: listed, and therefore not residue.
    expect(triage.items.map((item) => item.id)).toContain("app:unknown.exe");
    expect(triage.residual).toEqual({ entities: 1, seconds: 30 });
  });

  // One exact rule clears a partly-classified row either way, but what it
  // costs to do so is not the same on both kinds — which is the asymmetry the
  // Unclassified section's omission of these rows is really protecting.
  //
  // An App rule is priority 3, below every other claim, so it takes the residue
  // and leaves the Window rule holding exactly what it held.
  it("clears a partly-classified app with an App rule, leaving the Window rule intact", () => {
    const partial: ActivitySource = {
      ...source,
      rules: [{ id: 1, matchType: "title", pattern: "spec", categoryId: 1, priority: 2 }],
      sessions: [
        { id: 1, start: 10, end: 40, process: "notes.exe", title: "spec draft", domain: null, isAfk: false },
        { id: 2, start: 40, end: 100, process: "notes.exe", title: "grocery list", domain: null, isAfk: false },
      ],
    };
    const before = queryActivityIndex(buildActivityIndex(partial), baseQuery);
    expect(before.catalog.rows.find((row) => row.id === "app:notes.exe")?.status).toBe("partial");
    expect(before.triage.residual).toEqual({ entities: 1, seconds: 60 });

    const after = queryActivityIndex(
      buildActivityIndex({
        ...partial,
        rules: [...partial.rules, { id: 2, matchType: "process", pattern: "notes.exe", categoryId: 2, priority: 3 }],
      }),
      baseQuery,
    );
    const notes = after.catalog.rows.find((row) => row.id === "app:notes.exe");
    expect(notes?.uncategorizedSeconds).toBe(0);
    // Mixed, not single: the Window rule kept the 30s it was already winning.
    expect(notes?.status).toBe("mixed");
    expect(after.triage.residual).toEqual({ entities: 0, seconds: 0 });
  });

  // A Website rule is priority 1 and outranks an unscoped Window rule, so the
  // same one-click assignment does not merely fill the gap — it takes the
  // sessions the Window rule was classifying. Offering that from a five-row
  // list, on the row a browser always tops, is what the section declines to do.
  it("lets a Website rule take time an unscoped Window rule was already winning", () => {
    const before = queryActivityIndex(buildActivityIndex(source), baseQuery);
    const wasExample = before.catalog.rows.find((row) => row.id === "website:example.com");
    expect(wasExample?.status).toBe("partial");
    // 30s classified by the title rule, 30s not.
    expect(wasExample?.categories.map((category) => category.categoryId)).toEqual([2]);

    const after = queryActivityIndex(
      buildActivityIndex({
        ...source,
        rules: [...rules, { id: 9, matchType: "domain", pattern: "example.com", categoryId: 1, priority: 1 }],
      }),
      baseQuery,
    );
    const example = after.catalog.rows.find((row) => row.id === "website:example.com");
    expect(example?.uncategorizedSeconds).toBe(0);
    // Single, not mixed: the Website rule swallowed the Window rule's share too.
    expect(example?.status).toBe("single");
    expect(example?.categories.map((category) => category.categoryId)).toEqual([1]);
  });

  // What the starter list is offered against. It has to reach past the five
  // rows the section lists, because the small tedious apps a suggestion saves
  // the most effort on are exactly the ones ranked below the fold.
  it("offers every pending app for suggestions, uncapped and without websites", () => {
    const many: ActivitySource = {
      ...source,
      sessions: Array.from({ length: TRIAGE_VISIBLE + 3 }, (_, index) => ({
        id: index + 100,
        start: 1000 + index * 100,
        // Descending durations keep the order deterministic.
        end: 1000 + index * 100 + (90 - index),
        process: `pending${index}.exe`,
        title: "",
        domain: null,
        isAfk: false,
      })),
    };
    const { triage } = queryActivityIndex(buildActivityIndex(many), baseQuery);
    expect(triage.items).toHaveLength(TRIAGE_VISIBLE);
    expect(triage.pendingApps).toHaveLength(TRIAGE_VISIBLE + 3);
    expect(triage.pendingApps[0].key).toBe("pending0.exe");
  });

  // The starter list says nothing about websites, so they stay in the backlog
  // and out of the list suggestions are computed from.
  it("keeps websites out of the suggestible list while still counting them", () => {
    const withPendingSite: ActivitySource = {
      ...source,
      sessions: [
        ...source.sessions,
        { id: 20, start: 300, end: 400, process: "chrome.exe", title: "Reading", domain: "nobody.test", isAfk: false },
      ],
    };
    const { triage } = queryActivityIndex(buildActivityIndex(withPendingSite), baseQuery);
    expect(triage.items.map((item) => item.id)).toContain("website:nobody.test");
    expect(triage.pendingApps.map((item) => item.id)).toEqual(["app:unknown.exe"]);
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
    expect({ apps: editor.catalog.apps, websites: editor.catalog.websites }).toEqual({
      apps: 1,
      websites: 0,
    });
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

  it("filters Window results by their parent identity type", () => {
    const index = buildActivityIndex(source);
    const appsOnly = queryActivityIndex(index, { ...baseQuery, search: "mail", typeFilter: "app" });
    expect(appsOnly.catalog.total).toBe(0);
    expect(appsOnly.windowMatches?.rows).toEqual([]);

    const websitesOnly = queryActivityIndex(index, {
      ...baseQuery,
      search: "mail",
      typeFilter: "website",
    });
    expect(websitesOnly.windowMatches?.rows[0].sessionIds).toEqual([3]);

    const allTypes = queryActivityIndex(index, { ...baseQuery, search: "mail" });
    expect(allTypes.windowMatches?.rows[0].sessionIds).toEqual([3]);
  });

  it("filters Windows by their own classification rather than their parent identity", () => {
    const index = buildActivityIndex({
      categories: [
        ...categories,
        { id: 4, name: "Private", color: "#555", isProductive: false, isNeutral: false, isIgnored: true, sortOrder: 4 },
      ],
      browserProcesses: [],
      aliases: {},
      rules: [
        { id: 30, matchType: "process", pattern: "workspace.exe", categoryId: 1, priority: 3 },
        { id: 31, matchType: "title", pattern: "video", categoryId: 2, priority: 2 },
        { id: 32, matchType: "process", pattern: "shell.exe", categoryId: 3, priority: 3 },
      ],
      sessions: [
        { id: 80, start: 0, end: 10, process: "workspace.exe", title: "Claude project", domain: null, isAfk: false },
        { id: 81, start: 10, end: 20, process: "workspace.exe", title: "Claude video", domain: null, isAfk: false },
        { id: 82, start: 20, end: 30, process: "workspace.exe", title: "Claude mixed", domain: null, isAfk: false },
        { id: 83, start: 30, end: 40, process: "workspace.exe", title: "Claude mixed", domain: null, isAfk: false, categoryOverrideId: 2, isCorrected: true },
        { id: 84, start: 40, end: 50, process: "loose.exe", title: "Claude loose", domain: null, isAfk: false },
        { id: 85, start: 50, end: 60, process: "shell.exe", title: "Claude ignored", domain: null, isAfk: false },
        { id: 86, start: 60, end: 70, process: "shell.exe", title: "Claude ignored", domain: null, isAfk: false, categoryOverrideId: 4, isCorrected: true },
      ],
    });
    const titles = (classificationFilter: ActivityQuery["classificationFilter"]) =>
      queryActivityIndex(index, {
        ...baseQuery,
        search: "claude",
        classificationFilter,
      }).windowMatches!.rows.map((group) => group.title).sort();

    expect(titles("category:1")).toEqual(["Claude mixed", "Claude project"]);
    expect(titles("category:2")).toEqual(["Claude mixed", "Claude video"]);
    expect(titles("mixed")).toEqual(["Claude mixed"]);
    expect(titles("uncategorized")).toEqual(["Claude loose"]);
    expect(titles("ignored")).toEqual(["Claude ignored"]);
  });

  it("collapses repeat visits to one window into a single row", () => {
    // The shape a real database takes: one window returned to over and over,
    // each visit its own storage row. Read row by row it is 4 results; read as
    // a thing it is one window worth 70 seconds.
    const index = buildActivityIndex({
      ...source,
      sessions: [
        { id: 1, start: 0, end: 30, process: "obsidian.exe", title: "Project Atlas — roadmap", domain: null, isAfk: false },
        { id: 2, start: 40, end: 50, process: "obsidian.exe", title: "Project Atlas — roadmap", domain: null, isAfk: false },
        { id: 3, start: 60, end: 65, process: "obsidian.exe", title: "Groceries", domain: null, isAfk: false },
        { id: 4, start: 70, end: 100, process: "obsidian.exe", title: "Project Atlas — roadmap", domain: null, isAfk: false },
      ],
    });
    const found = queryActivityIndex(index, { ...baseQuery, search: "e" });
    const groups = found.windowMatches!;
    expect(groups.total).toBe(2);
    expect(groups.sessionTotal).toBe(4);
    const [first, second] = groups.rows;
    // Heaviest window first, not most recent.
    expect(first.title).toBe("Project Atlas — roadmap");
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

  it("reports varying provenance when visits share a category but not its source", () => {
    const index = buildActivityIndex({
      ...source,
      sessions: [
        { id: 1, start: 0, end: 30, process: "code.exe", title: "Project", domain: null, isAfk: false },
        // Same category as the App rule, but assigned directly on this visit.
        { id: 2, start: 40, end: 70, process: "code.exe", title: "Project", domain: null, isAfk: false, categoryOverrideId: 1, isCorrected: true },
      ],
    });
    const group = queryActivityIndex(index, { ...baseQuery, search: "project" }).windowMatches!.rows[0];
    expect(group.mixed).toBe(false);
    expect(group.categoryName).toBe("Focus");
    expect(group.provenanceMixed).toBe(true);
    expect(group.classificationSource).toBeNull();
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

  it("totals the time each rule decided, omitting one nothing matches", () => {
    const usage = new Map(
      queryActivityIndex(buildActivityIndex(source), baseQuery).ruleUsageSeconds,
    );
    expect([...usage.keys()].sort()).toEqual([1, 3, 4, 5]);
    expect(usage.get(1)).toBe(30);

    const unmatched = buildActivityIndex({
      ...source,
      rules: [...rules, { id: 9, matchType: "process", pattern: "never.exe", categoryId: 1, priority: 3 }],
    });
    expect(new Map(queryActivityIndex(unmatched, baseQuery).ruleUsageSeconds).has(9)).toBe(false);
  });

  it("measures rule use over all history rather than the queried range", () => {
    // Session 1 runs 10..40, so a range-clipped total would be 10 seconds here.
    const narrow = queryActivityIndex(buildActivityIndex(source), {
      ...baseQuery,
      endSec: 20,
    });
    expect(new Map(narrow.ruleUsageSeconds).get(1)).toBe(30);
  });

  it("adds up every session one rule wins", () => {
    const index = buildActivityIndex({
      ...source,
      sessions: [
        { id: 1, start: 10, end: 40, process: "code.exe", title: "A", domain: null, isAfk: false },
        { id: 2, start: 50, end: 110, process: "code.exe", title: "B", domain: null, isAfk: false },
      ],
    });
    expect(new Map(index.ruleUsageSeconds).get(1)).toBe(90);
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

  it("groups cosmetic title variants within an entity while preserving meaningful boundaries", () => {
    const index = buildActivityIndex({
      categories,
      browserProcesses: [],
      aliases: {},
      rules: [],
      sessions: [
        { id: 40, start: 0, end: 10, process: "editor.exe", title: "Report.docx - Word", domain: null, isAfk: false },
        { id: 41, start: 10, end: 20, process: "editor.exe", title: "● REPORT.DOCX   -   Word", domain: null, isAfk: false },
        { id: 42, start: 20, end: 30, process: "editor.exe", title: "Budget.docx - Word", domain: null, isAfk: false },
        { id: 43, start: 30, end: 40, process: "other.exe", title: "Report.docx - Word", domain: null, isAfk: false },
        { id: 44, start: 40, end: 50, process: "editor.exe", title: "Report.docx - Word 1.2", domain: null, isAfk: false },
      ],
    });

    const editor = queryActivityIndex(index, {
      ...baseQuery,
      selectedEntityId: "app:editor.exe",
    });
    expect(editor.detailGroups.total).toBe(3);
    expect(editor.detailGroups.rows.map((group) => ({
      title: group.title,
      sessionIds: group.sessionIds,
      sessionCount: group.sessionCount,
      seconds: group.seconds,
    }))).toEqual([
      {
        // Sessions are newest-first, so the latest original spelling is shown.
        title: "● REPORT.DOCX   -   Word",
        sessionIds: [41, 40],
        sessionCount: 2,
        seconds: 20,
      },
      // Equal times break to title, not to recency: the entity's window list
      // is ordered by the same comparator as the searched one, so the two
      // cannot answer the same tie differently.
      {
        title: "Budget.docx - Word",
        sessionIds: [42],
        sessionCount: 1,
        seconds: 10,
      },
      {
        title: "Report.docx - Word 1.2",
        sessionIds: [44],
        sessionCount: 1,
        seconds: 10,
      },
    ]);

    const searched = queryActivityIndex(index, { ...baseQuery, search: "report" });
    expect(searched.windowMatches?.total).toBe(3);
    expect(searched.windowMatches?.rows.map((group) => [group.entityId, group.sessionCount])).toEqual([
      ["app:editor.exe", 2],
      ["app:other.exe", 1],
      ["app:editor.exe", 1],
    ]);
  });

  it("sorts Window groups independently by every visible column", () => {
    const index = buildActivityIndex({
      categories,
      browserProcesses: [],
      aliases: {
        "z.exe": "Zulu",
        "a.exe": "Alpha source",
        "c.exe": "Charlie",
      },
      rules: [
        { id: 20, matchType: "process", pattern: "z.exe", categoryId: 1, priority: 3 },
        { id: 21, matchType: "process", pattern: "a.exe", categoryId: 2, priority: 3 },
      ],
      sessions: [
        { id: 70, start: localSec(2026, 3, 10, 9), end: localSec(2026, 3, 10, 9) + 10, process: "z.exe", title: "Alpha", domain: null, isAfk: false },
        { id: 71, start: localSec(2026, 3, 10, 10), end: localSec(2026, 3, 10, 10) + 20, process: "a.exe", title: "Beta", domain: null, isAfk: false },
        { id: 72, start: localSec(2026, 3, 11, 10), end: localSec(2026, 3, 11, 10) + 5, process: "a.exe", title: "Beta", domain: null, isAfk: false },
        { id: 73, start: localSec(2026, 3, 12, 10), end: localSec(2026, 3, 12, 10) + 15, process: "c.exe", title: "Gamma", domain: null, isAfk: false },
      ],
    });
    const titles = (
      windowSort: ActivityQuery["windowSort"],
      windowDirection: ActivityQuery["windowDirection"],
    ) => queryActivityIndex(index, {
      ...baseQuery,
      startSec: localSec(2026, 3, 1),
      endSec: localSec(2026, 3, 20),
      search: "a",
      windowSort,
      windowDirection,
    }).windowMatches!.rows.map((group) => group.title);

    expect(titles("title", "asc")).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(titles("seconds", "desc")).toEqual(["Beta", "Gamma", "Alpha"]);
    expect(titles("days", "desc")).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(titles("lastSeen", "desc")).toEqual(["Gamma", "Beta", "Alpha"]);
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

describe("Query stage reuse", () => {
  // queryActivityIndex memoizes its expensive stages on the index, keyed on
  // everything except the paging fields. These pin the two ways that can go
  // wrong: a page change altering more than the slice, and a stage answering
  // one query from another one's inputs.
  const index = buildActivityIndex(source);

  it("changes only the slice when a page grows", () => {
    const firstPage = queryActivityIndex(index, { ...baseQuery, entityLimit: 1 });
    const everything = queryActivityIndex(index, { ...baseQuery, entityLimit: 100 });
    expect(firstPage.catalog.total).toBe(everything.catalog.total);
    expect(firstPage.catalog.apps).toBe(everything.catalog.apps);
    expect(firstPage.catalog.websites).toBe(everything.catalog.websites);
    expect(firstPage.maxSeconds).toBe(everything.maxSeconds);
    expect(firstPage.totalSeconds).toBe(everything.totalSeconds);
    expect(firstPage.catalog.rows).toEqual(everything.catalog.rows.slice(0, 1));
  });

  it("answers a repeated query the same way after others have run", () => {
    const before = queryActivityIndex(index, baseQuery);
    // More distinct shapes than any one stage will hold, so the first query's
    // entries are evicted rather than merely shadowed.
    for (const other of [
      { ...baseQuery, sort: "name" as const },
      { ...baseQuery, typeFilter: "website" as const },
      { ...baseQuery, classificationFilter: "uncategorized" as const },
      { ...baseQuery, search: "e" },
      { ...baseQuery, startSec: 0, endSec: 5 },
      { ...baseQuery, startSec: 20, endSec: 90 },
      { ...baseQuery, direction: "asc" as const },
      { ...baseQuery, selectedEntityId: "website:example.com" },
    ]) queryActivityIndex(index, other);
    expect(queryActivityIndex(index, baseQuery)).toEqual(before);
  });

  it("keeps a noise policy out of an answer given without one", () => {
    const policy = { mode: "one_off" as const, maxSeconds: 60, maxSessions: 1 };
    const plain = queryActivityIndex(index, baseQuery);
    queryActivityIndex(index, { ...baseQuery, noise: policy });
    expect(queryActivityIndex(index, baseQuery)).toEqual(plain);
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
      { id: 60, start: localSec(2026, 3, 10, 9), end: localSec(2026, 3, 10, 10), process: "app.exe", title: "Daily work", domain: null, isAfk: false },
      { id: 61, start: localSec(2026, 3, 10, 14), end: localSec(2026, 3, 10, 15), process: "app.exe", title: "Daily work", domain: null, isAfk: false },
      { id: 62, start: localSec(2026, 3, 11, 9), end: localSec(2026, 3, 11, 10), process: "app.exe", title: "Daily work", domain: null, isAfk: false },
      // One session across midnight is activity on both dates.
      { id: 63, start: localSec(2026, 3, 12, 23), end: localSec(2026, 3, 13, 1), process: "night.exe", title: "Night work", domain: null, isAfk: false },
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

  it("uses the same distinct-day measure for grouped Windows", () => {
    const result = queryActivityIndex(buildActivityIndex(spanning), {
      ...wideQuery,
      search: "work",
    });
    expect(result.windowMatches?.rows.map((row) => [row.entityId, row.daysSeen])).toEqual([
      ["app:app.exe", 2],
      ["app:night.exe", 2],
    ]);
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
      { id: 70, start: 100, end: 200, process: "old.exe", title: "Old window", domain: null, isAfk: false },
      { id: 71, start: 1000, end: 1100, process: "old.exe", title: "Old window", domain: null, isAfk: false },
      { id: 72, start: 1000, end: 1100, process: "fresh.exe", title: "Fresh window", domain: null, isAfk: false },
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
    const windows = queryActivityIndex(buildActivityIndex(history), {
      ...baseQuery,
      startSec: 900,
      endSec: 2000,
      search: "window",
    }).windowMatches!.rows;
    expect(windows.find((row) => row.entityId === "app:fresh.exe")?.isNew).toBe(true);
    expect(windows.find((row) => row.entityId === "app:old.exe")?.isNew).toBe(false);
  });

  it("marks nothing when the range reaches back to the first session ever", () => {
    const result = queryActivityIndex(buildActivityIndex(history), {
      ...baseQuery,
      startSec: 0,
      endSec: 2000,
    });
    expect(result.catalog.rows.every((row) => !row.isNew)).toBe(true);
    const windows = queryActivityIndex(buildActivityIndex(history), {
      ...baseQuery,
      startSec: 0,
      endSec: 2000,
      search: "window",
    }).windowMatches!.rows;
    expect(windows.every((row) => !row.isNew)).toBe(true);
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

  it("uses one scale for identity and Window results in a search", () => {
    const index = buildActivityIndex({
      ...source,
      rules: [],
      browserProcesses: [],
      sessions: [
        { id: 80, start: 0, end: 30, process: "needle.exe", title: "Other", domain: null, isAfk: false },
        { id: 81, start: 40, end: 140, process: "other.exe", title: "Needle result", domain: null, isAfk: false },
      ],
    });
    const result = queryActivityIndex(index, { ...baseQuery, search: "needle" });
    expect(result.catalog.rows.map((row) => row.seconds)).toEqual([30]);
    expect(result.windowMatches?.rows.map((row) => row.seconds)).toEqual([100]);
    expect(result.maxSeconds).toBe(100);
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

describe("bucketDailyUsage", () => {
  /** Local wall-clock, because the buckets are local calendar days and CI runs
   *  the suite under two different timezones. */
  const at = (year: number, month: number, day: number, hour = 0) =>
    new Date(year, month - 1, day, hour).getTime() / 1000;

  it("lays spans out over the range's days, keeping the empty ones", () => {
    const buckets = bucketDailyUsage(
      [{ start: at(2026, 3, 1, 9), end: at(2026, 3, 1, 10) }],
      at(2026, 3, 1),
      at(2026, 3, 5),
    );
    // Four columns for four days: a gap is most of what the strip is for, so
    // the three untouched days survive as zeroes rather than being dropped.
    expect(buckets.map((bucket) => bucket.seconds)).toEqual([3600, 0, 0, 0]);
    expect(buckets.every((bucket) => bucket.days === 1)).toBe(true);
  });

  it("splits a span at midnight onto both days it happened on", () => {
    const buckets = bucketDailyUsage(
      [{ start: at(2026, 3, 1, 23), end: at(2026, 3, 2, 1) }],
      at(2026, 3, 1),
      at(2026, 3, 3),
    );
    expect(buckets.map((bucket) => bucket.seconds)).toEqual([3600, 3600]);
  });

  it("ignores time outside the range rather than folding it into an edge column", () => {
    const buckets = bucketDailyUsage(
      [{ start: at(2026, 2, 27, 9), end: at(2026, 2, 27, 10) }],
      at(2026, 3, 1),
      at(2026, 3, 3),
    );
    expect(buckets.map((bucket) => bucket.seconds)).toEqual([0, 0]);
  });

  it("folds days together once a range holds more of them than the strip draws", () => {
    const buckets = bucketDailyUsage(
      [
        { start: at(2026, 3, 1, 9), end: at(2026, 3, 1, 10) },
        { start: at(2026, 3, 4, 9), end: at(2026, 3, 4, 10) },
      ],
      at(2026, 3, 1),
      at(2026, 3, 7),
      3,
    );
    // Six days into three columns of two, and both hours land in the first —
    // the 1st and the 4th are two days apart but the fold is not by proximity.
    expect(buckets.map((bucket) => bucket.days)).toEqual([2, 2, 2]);
    expect(buckets.map((bucket) => bucket.seconds)).toEqual([3600, 3600, 0]);
  });

  it("clips the last column to the range, so it cannot claim a day never covered", () => {
    const buckets = bucketDailyUsage([], at(2026, 3, 1), at(2026, 3, 2, 12));
    expect(buckets).toHaveLength(2);
    expect(buckets[1].endSec).toBe(at(2026, 3, 2, 12));
  });

  it("has nothing to draw for an empty range", () => {
    expect(bucketDailyUsage([], at(2026, 3, 1), at(2026, 3, 1))).toEqual([]);
  });
});

describe("the selected entity's usage strip", () => {
  it("describes the entity, not the window filter narrowing the list beside it", () => {
    const index = buildActivityIndex(source);
    const unfiltered = queryActivityIndex(index, {
      ...baseQuery,
      selectedEntityId: "website:example.com",
    });
    const filtered = queryActivityIndex(index, {
      ...baseQuery,
      selectedEntityId: "website:example.com",
      detailSearch: "mail",
    });
    // The filter removed a window from the list, so the two disagree there…
    expect(filtered.detailGroups.total).toBeLessThan(unfiltered.detailGroups.total);
    // …but "when was this site open" is not a question the filter can answer
    // differently, so the strip must not move.
    expect(filtered.selectedEntityUsage).toEqual(unfiltered.selectedEntityUsage);
  });

  it("is empty when nothing is selected", () => {
    const index = buildActivityIndex(source);
    expect(queryActivityIndex(index, baseQuery).selectedEntityUsage).toEqual([]);
  });
});

describe("window list ordering in the entity panel", () => {
  it("takes the order the panel asks for", () => {
    const index = buildActivityIndex(source);
    const byTitle = queryActivityIndex(index, {
      ...baseQuery,
      selectedEntityId: "website:example.com",
      detailSort: "title",
      detailDirection: "asc",
    });
    const titles = byTitle.detailGroups.rows.map((group) => group.title);
    expect(titles).toEqual([...titles].sort((left, right) => left.localeCompare(right)));
  });

  it("scales its bars against the heaviest window, not the heaviest on the page", () => {
    const index = buildActivityIndex(source);
    const paged = queryActivityIndex(index, {
      ...baseQuery,
      selectedEntityId: "website:example.com",
      detailLimit: 1,
      detailSort: "title",
      detailDirection: "asc",
    });
    expect(paged.detailGroups.rows).toHaveLength(1);
    // Sorted alphabetically, so the first page need not hold the longest
    // window — a bar drawn against the page alone would rescale on "load more".
    const everyWindow = queryActivityIndex(index, {
      ...baseQuery,
      selectedEntityId: "website:example.com",
    });
    expect(paged.detailGroups.maxSeconds).toBe(
      Math.max(...everyWindow.detailGroups.rows.map((group) => group.seconds)),
    );
  });
});

describe("visits carried for the inspected window", () => {
  /** One window, returned to far more often than a group's summary sample. */
  const many = buildActivityIndex({
    categories,
    browserProcesses: [],
    aliases: {},
    rules: [],
    sessions: Array.from({ length: 60 }, (_, i) => ({
      id: 100 + i,
      start: i * 10,
      end: i * 10 + 5,
      process: "editor.exe",
      title: "Notes - Editor",
      domain: null,
      isAfk: false,
    })),
  });
  const selected: ActivityQuery = {
    ...baseQuery,
    endSec: 10_000,
    selectedEntityId: "app:editor.exe",
  };
  const windowKey = () =>
    queryActivityIndex(many, selected).detailGroups.rows[0].key;

  it("still samples every other group, so the payload stays bounded", () => {
    const group = queryActivityIndex(many, selected).detailGroups.rows[0];
    expect(group.sessionCount).toBe(60);
    expect(group.sessions).toHaveLength(GROUP_SESSION_SAMPLE);
  });

  it("hands the inspected window as many visits as it asks for", () => {
    const result = queryActivityIndex(many, {
      ...selected,
      selectedWindowKey: windowKey(),
      selectedWindowSessionLimit: 45,
    });
    const group = result.selectedWindow!;
    expect(group.sessions).toHaveLength(45);
    // Newest first, so paging deeper reaches steadily older visits — the ones
    // that could not be ticked or corrected at all before.
    expect(group.sessions[0].start).toBeGreaterThan(group.sessions[44].start);
  });

  it("returns the inspected window even when its detail row is outside the page", () => {
    const mixed = buildActivityIndex({
      categories,
      browserProcesses: [],
      aliases: {},
      rules: [],
      sessions: [
        { id: 1, start: 10, end: 20, process: "editor.exe", title: "First - Editor", domain: null, isAfk: false },
        { id: 2, start: 30, end: 50, process: "editor.exe", title: "Second - Editor", domain: null, isAfk: false },
      ],
    });
    const unpaged = queryActivityIndex(mixed, { ...selected, detailSort: "title", detailDirection: "asc" });
    const inspectedKey = unpaged.detailGroups.rows[1].key;
    const result = queryActivityIndex(mixed, {
      ...selected,
      detailSort: "title",
      detailDirection: "asc",
      detailLimit: 1,
      selectedWindowKey: inspectedKey,
    });

    expect(result.detailGroups.rows).toHaveLength(1);
    expect(result.detailGroups.rows[0].key).not.toBe(inspectedKey);
    expect(result.selectedWindow?.key).toBe(inspectedKey);
    expect(result.selectedWindow?.sessions).toHaveLength(1);
  });

  it("never hands back more than the window actually has", () => {
    const group = queryActivityIndex(many, {
      ...selected,
      selectedWindowKey: windowKey(),
      selectedWindowSessionLimit: 500,
    }).detailGroups.rows[0];
    expect(group.sessions).toHaveLength(60);
  });

  it("leaves no expanded visit list behind for the next query", () => {
    // The inspected group's visits are substituted into the returned page
    // rather than written onto the grouped row, which the stage memo holds on
    // to. Asking again without the request has to give the sample back.
    queryActivityIndex(many, {
      ...selected,
      selectedWindowKey: windowKey(),
      selectedWindowSessionLimit: 45,
    });
    expect(queryActivityIndex(many, selected).detailGroups.rows[0].sessions).toHaveLength(
      GROUP_SESSION_SAMPLE,
    );
  });

  it("leaves the other groups sampled when one is inspected", () => {
    const mixed = buildActivityIndex({
      categories,
      browserProcesses: [],
      aliases: {},
      rules: [],
      sessions: [
        ...Array.from({ length: 40 }, (_, i) => ({
          id: 200 + i, start: i * 10, end: i * 10 + 5,
          process: "editor.exe", title: "First - Editor", domain: null, isAfk: false,
        })),
        ...Array.from({ length: 40 }, (_, i) => ({
          id: 300 + i, start: 1000 + i * 10, end: 1000 + i * 10 + 4,
          process: "editor.exe", title: "Second - Editor", domain: null, isAfk: false,
        })),
      ],
    });
    const query = { ...baseQuery, endSec: 10_000, selectedEntityId: "app:editor.exe" };
    const rows = queryActivityIndex(mixed, query).detailGroups.rows;
    const inspected = queryActivityIndex(mixed, {
      ...query,
      selectedWindowKey: rows[0].key,
      selectedWindowSessionLimit: 40,
    }).detailGroups.rows;
    expect(inspected[0].sessions).toHaveLength(40);
    expect(inspected[1].sessions).toHaveLength(GROUP_SESSION_SAMPLE);
  });
});

const selectionGroup = (key: string, sessionIds: number[]): ActivityTitleGroup => ({
  key,
  sessionIds,
} as ActivityTitleGroup);

const selectionResult = (
  selectedWindow: ActivityTitleGroup | null,
  detailRows: ActivityTitleGroup[] = [],
  searchRows: ActivityTitleGroup[] = [],
): ActivityQueryResult => ({
  selectedWindow,
  detailGroups: { rows: detailRows },
  windowMatches: searchRows.length > 0 ? { rows: searchRows } : null,
} as unknown as ActivityQueryResult);

describe("Activity selection freshness", () => {
  it("keeps the old Window only while the replacement result is stale", () => {
    const oldWindow = selectionGroup("old", [1]);
    const freshWindow = selectionGroup("fresh", [2]);

    expect(resolveSelectedWindow(oldWindow, selectionResult(freshWindow), false)).toBe(oldWindow);
    expect(resolveSelectedWindow(oldWindow, selectionResult(freshWindow), true)).toBe(freshWindow);
  });

  it("closes the Window when the current result no longer contains it", () => {
    const oldWindow = selectionGroup("old", [1]);
    expect(resolveSelectedWindow(oldWindow, selectionResult(null), true)).toBeNull();
  });
});

describe("Activity mutation session boundary", () => {
  it("intersects classify/delete IDs with rows in the current result", () => {
    const freshWindow = selectionGroup("fresh", [20, 21]);
    const current = selectionResult(
      freshWindow,
      [selectionGroup("detail", [10, 11])],
      [selectionGroup("search", [30])],
    );

    expect([...currentActivitySessionIds(current)].sort((a, b) => a - b)).toEqual([10, 11, 20, 21, 30]);
    expect([...restrictActivitySessionIds([1, 10, 21, 999, 10], current)].sort((a, b) => a - b))
      .toEqual([10, 21]);
    expect([...restrictActivitySessionIds([10, 21], null)]).toEqual([]);
  });
});
