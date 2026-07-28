import { describe, expect, it } from "vitest";

import {
  defaultRulePattern,
  describeCorrectionWindow,
  detailPanelBox,
  formatDateSpan,
  formatVisitDay,
  groupVisitsByDay,
  windowRowCategory,
  entityClassification,
  formatLastSeen,
  titleMatchParts,
} from "./ActivityTab";
import { previewTitleRule } from "../lib/titleRuleAnalysis";
import type { Category, Rule, TitleRuleSpec } from "../lib/classify";
import type { ActivityEntitySummary, ActivitySource } from "../lib/activity";

/** Boundaries are calendar dates, not elapsed hours: 00:30 and 23:30 on the
 *  same date are both "today", and 23:30 last night is "Yesterday" even though
 *  it is an hour ago. Built from local wall-clock parts so the assertions hold
 *  in every timezone CI runs the suite under. */
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

const sec = (date: Date) => date.getTime() / 1000;

describe("formatLastSeen", () => {
  const now = at(2026, 7, 24, 9, 37);

  it("gives the time of day for anything seen today", () => {
    expect(formatLastSeen(sec(at(2026, 7, 24, 0, 30)), now)).toMatch(/^Today, /);
    expect(formatLastSeen(sec(at(2026, 7, 24, 9, 12)), now)).toMatch(/^Today, /);
  });

  it("names yesterday rather than making the reader work out the date", () => {
    expect(formatLastSeen(sec(at(2026, 7, 23, 23, 30)), now)).toBe("Yesterday");
    expect(formatLastSeen(sec(at(2026, 7, 23, 0, 5)), now)).toBe("Yesterday");
  });

  it("falls back to the date once a name would stop being clearer", () => {
    expect(formatLastSeen(sec(at(2026, 7, 22, 16, 0)), now)).toMatch(/22/);
    expect(formatLastSeen(sec(at(2026, 1, 3, 16, 0)), now)).toMatch(/2026/);
  });

  it("treats a live session's end as today rather than the future", () => {
    expect(formatLastSeen(sec(at(2026, 7, 24, 23, 59)), now)).toMatch(/^Today, /);
  });
});

describe("titleMatchParts", () => {
  it("marks the match and keeps the stored casing", () => {
    expect(titleMatchParts("Inbox - Mail", "mail")).toEqual({
      elided: false,
      head: "Inbox - ",
      hit: "Mail",
      tail: "",
    });
  });

  it("windows a late match into view rather than letting truncation hide it", () => {
    const title = "Pull request #4120: rewrite the activity index - myrepo - Chromium";
    const parts = titleMatchParts(title, "myrepo");
    expect(parts?.elided).toBe(true);
    expect(parts?.hit).toBe("myrepo");
    // Reassembling from the elision point has to give back the tail of the
    // original: a window that drops or duplicates characters is worse than a
    // clip, because it reads as recorded text.
    expect(`${parts?.head}${parts?.hit}${parts?.tail}`).toBe(
      title.slice(title.indexOf("myrepo") - 30),
    );
  });

  it("does not elide when the match is already near the start", () => {
    expect(titleMatchParts("Docs - Project", "Docs")?.elided).toBe(false);
  });

  it("returns nothing to mark for an empty title, empty search, or no match", () => {
    expect(titleMatchParts("", "mail")).toBeNull();
    expect(titleMatchParts("Inbox", "")).toBeNull();
    expect(titleMatchParts("Inbox", "spreadsheet")).toBeNull();
  });
});

describe("defaultRulePattern", () => {
  it("uses one durable title part while history-backed ranking loads", () => {
    expect(defaultRulePattern("roadmap.md - Skill Tree - Obsidian")).toBe("skill tree");
    expect(defaultRulePattern("Inbox — Mail")).toBe("inbox");
    expect(defaultRulePattern("Pull request #12 | myrepo")).toBe("pull request #12");
  });

  it("never falls back to a version-bearing segment", () => {
    expect(defaultRulePattern("v2.4 - Skill Tree - Obsidian")).toBe("skill tree");
  });

  it("leaves a title with no separators alone", () => {
    expect(defaultRulePattern("Claude")).toBe("claude");
  });

  it("does not treat a hyphen inside a word as a separator", () => {
    expect(defaultRulePattern("well-known things")).toBe("well-known things");
  });
});

describe("previewTitleRule", () => {
  const categories: Category[] = [
    { id: 1, name: "Dev", color: "#111", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
    { id: 2, name: "Notes", color: "#222", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 2 },
  ];
  const rules: Rule[] = [
    { id: 1, matchType: "process", pattern: "obsidian.exe", categoryId: 2, priority: 3 },
  ];
  const source: ActivitySource = {
    categories,
    rules,
    browserProcesses: ["chrome.exe"],
    aliases: {},
    sessions: [
      { id: 1, start: 0, end: 60, process: "obsidian.exe", title: "Skill Tree — roadmap", domain: null, isAfk: false },
      { id: 2, start: 60, end: 120, process: "obsidian.exe", title: "Groceries", domain: null, isAfk: false },
      { id: 3, start: 120, end: 180, process: "chrome.exe", title: "Skill Tree issue", domain: "github.com", isAfk: false },
      { id: 4, start: 180, end: 240, process: "obsidian.exe", title: "Skill Tree — notes", domain: null, isAfk: true },
    ],
  };
  const spec = (
    scopeKind: TitleRuleSpec["scopeKind"],
    scopeValue = "",
  ): TitleRuleSpec => ({
    pattern: "skill tree",
    scopeKind,
    scopeValue,
    titleMatchMode: "phrase",
    titleAnchor: "any",
  });

  it("counts what an unscoped rule would claim, across every app", () => {
    const preview = previewTitleRule(source, spec("any"));
    expect(preview.sessions).toBe(2); // the AFK row is never classified
    expect(preview.seconds).toBe(120);
    expect(preview.entities).toBe(2); // obsidian.exe and github.com
    expect(preview.titles).toBe(2);
  });

  it("honours the scope it is asked about", () => {
    expect(previewTitleRule(source, spec("process", "obsidian.exe")).sessions).toBe(1);
    expect(previewTitleRule(source, spec("browsers")).sessions).toBe(1);
  });

  it("separates sessions that would change category from ones merely claimed", () => {
    // Session 1 is Notes today via the App rule, so the new rule takes it away.
    // Session 3 has no rule at all, so it is claimed but not reclassified.
    const preview = previewTitleRule(source, spec("any"));
    expect(preview.reclassified).toBe(1);
  });

  it("does not count sessions an existing higher-priority rule already wins", () => {
    const shadowed: ActivitySource = {
      ...source,
      // A domain rule outranks any title rule, so the browser session is not
      // this rule's to claim.
      rules: [...rules, { id: 2, matchType: "domain", pattern: "github.com", categoryId: 1, priority: 1 }],
    };
    const preview = previewTitleRule(shadowed, spec("any"));
    expect(preview.sessions).toBe(1);
    expect(preview.entities).toBe(1);
  });

  it("reports nothing for a pattern that matches no stored title", () => {
    expect(previewTitleRule(source, { ...spec("any"), pattern: "nonexistent" })).toEqual({
      sessions: 0,
      seconds: 0,
      days: 0,
      titles: 0,
      entities: 0,
      reclassified: 0,
    });
  });
});

describe("describeCorrectionWindow", () => {
  const base = { start: 1_000, end: 2_000 };

  it("leads with shorten-only when neighbours abut both ends", () => {
    // The normal case for a continuously-recording tracker, and the one the
    // dialog used to reveal only by rejecting the save.
    const text = describeCorrectionWindow({ ...base, earliestStart: 1_000, latestEnd: 2_000 });
    expect(text).toBe(
      "You can shorten this session but not extend it — the sessions before and after leave no gap.",
    );
  });

  it("gives the outer bounds when there is room on both sides", () => {
    const text = describeCorrectionWindow({ ...base, earliestStart: 400, latestEnd: 2_600 });
    expect(text).toMatch(/^This session can run from .+ to .+ at most, before it would overlap another\.$/);
  });

  it("still gives bounds when only one side has room", () => {
    // The start is pinned but the end can move, so stating the pair is honest:
    // the range simply begins where it already is.
    const text = describeCorrectionWindow({ ...base, earliestStart: 1_000, latestEnd: 2_600 });
    expect(text).toContain("can run from");
  });

  it("says when nothing is recorded on one side", () => {
    expect(describeCorrectionWindow({ ...base, earliestStart: null, latestEnd: 2_600 }))
      .toContain("Nothing is recorded before this session");
    expect(describeCorrectionWindow({ ...base, earliestStart: 400, latestEnd: null }))
      .toContain("nothing is recorded after it");
  });

  it("says the times move freely when the session stands alone", () => {
    expect(describeCorrectionWindow({ ...base, earliestStart: null, latestEnd: null })).toBe(
      "Nothing else is recorded around this session, so its times can move freely.",
    );
  });

  it("states bounds to the second, since a real gap can be shorter than a minute", () => {
    // A tracker restart leaves about forty seconds. To the minute, both bounds
    // print the same time and the message reads as "no room" when there is.
    const start = new Date(2026, 6, 27, 10, 52, 37).getTime() / 1000;
    const text = describeCorrectionWindow({
      start,
      end: start + 11,
      earliestStart: start - 42,
      latestEnd: start + 11,
    });
    expect(text).toContain("51:55");
  });

  it("never uses vocabulary the rest of the app does not", () => {
    // "Recordings sit flush" was carpentry, and introduced a third noun for a
    // thing the app calls a session everywhere else.
    for (const bounds of [
      { earliestStart: 1_000, latestEnd: 2_000 },
      { earliestStart: 400, latestEnd: 2_600 },
      { earliestStart: null, latestEnd: null },
      { earliestStart: null, latestEnd: 2_600 },
      { earliestStart: 400, latestEnd: null },
    ]) {
      const text = describeCorrectionWindow({ ...base, ...bounds });
      expect(text).not.toMatch(/flush|recordings/i);
    }
  });
});

describe("entityClassification", () => {
  const base: ActivityEntitySummary = {
    id: "app:code.exe",
    kind: "app",
    key: "code.exe",
    displayName: "Editor",
    sourceProcesses: ["code.exe"],
    seconds: 3600,
    sessionCount: 4,
    daysSeen: 2,
    firstSeen: 0,
    lastSeen: 3600,
    uncategorizedSeconds: 0,
    categories: [{ categoryId: 1, name: "Focus", color: "#00f", isIgnored: false, seconds: 3600 }],
    rules: [],
    status: "single",
    exactRuleId: null,
    noise: null,
    isNew: false,
  };
  const rule = (over: Partial<ActivityEntitySummary["rules"][number]> = {}) => ({
    ruleId: 1,
    matchType: "process" as const,
    pattern: "code.exe",
    categoryId: 1,
    categoryName: "Focus",
    categoryColor: "#00f",
    sessions: 4,
    seconds: 3600,
    ...over,
  });

  it("names the kind of rule that decided it", () => {
    const summary = entityClassification({ ...base, rules: [rule()] });
    expect(summary.label).toBe("Focus");
    // Not "App rule · code.exe": the pattern is this entity's own key, which
    // the panel prints under the title two lines above.
    expect(summary.detail).toBe("App rule");
  });

  it("prints a pattern the header does not already show", () => {
    const summary = entityClassification({
      ...base,
      rules: [rule({ matchType: "title", pattern: "skill tree" })],
    });
    expect(summary.detail).toBe("Window rule · skill tree");
  });

  it("says so when a rule explains only part of the time", () => {
    // The rule covers half; the rest can only have come from corrections, and
    // pointing at the rule alone would send someone editing the wrong thing.
    const summary = entityClassification({ ...base, rules: [rule({ seconds: 1800 })] });
    expect(summary.detail).toBe("App rule, plus manual corrections");
  });

  it("attributes a categorized entity with no rule to corrections", () => {
    expect(entityClassification(base).detail).toMatch(/manual corrections/);
  });

  it("does not blame a rule for a rounding remainder", () => {
    const summary = entityClassification({ ...base, rules: [rule({ seconds: 3599 })] });
    expect(summary.detail).toBe("App rule");
  });

  it("reports the absence of a rule rather than a category name", () => {
    const summary = entityClassification({
      ...base,
      status: "uncategorized",
      categories: [],
      uncategorizedSeconds: 3600,
      kind: "website",
      key: "example.com",
    });
    expect(summary.label).toBe("Uncategorized");
    expect(summary.detail).toBe("No rule matches this website.");
  });

  it("quantifies what is still uncategorized in a partly-classified entity", () => {
    const summary = entityClassification({
      ...base,
      status: "partial",
      uncategorizedSeconds: 900,
    });
    expect(summary.label).toBe("Mixed");
    expect(summary.detail).toContain("15m");
  });

  it("counts the categories a mixed entity is split across", () => {
    const summary = entityClassification({
      ...base,
      status: "mixed",
      categories: [
        { categoryId: 1, name: "Focus", color: "#00f", isIgnored: false, seconds: 1800 },
        { categoryId: 2, name: "Media", color: "#f00", isIgnored: false, seconds: 1800 },
      ],
      rules: [rule({ seconds: 1800 }), rule({ ruleId: 2, seconds: 1800, matchType: "title", pattern: "mail" })],
    });
    expect(summary.label).toBe("Mixed · 2 categories");
    expect(summary.detail).toBe("2 rules decide it across its visits.");
  });

  it("explains what ignoring costs rather than merely naming the state", () => {
    const summary = entityClassification({ ...base, status: "ignored" });
    expect(summary.label).toBe("Ignored");
    expect(summary.detail).toMatch(/Insights/);
  });
});

describe("detail panel docking", () => {
  /** Where the page container's right edge lands: a 1152px column centred in
   *  the window, less its own 24px padding. Mirrors App.tsx's max-w-6xl px-6. */
  const cardRight = (viewport: number) => {
    const container = Math.min(viewport, 1152);
    return (viewport - container) / 2 + container - 24;
  };
  const box = (viewport: number) => detailPanelBox(viewport, cardRight(viewport));

  it("fills the margin without touching the table on a large desktop", () => {
    // The 32" monitor this was designed against, at its usual scaling.
    expect(box(2208)).toEqual({ left: 1672, width: 512, overlap: 0 });
  });

  it("still clears the table on an unscaled 1080p screen", () => {
    expect(box(1920).overlap).toBe(0);
    expect(box(1920).width).toBe(368);
  });

  it("stops widening before a window title becomes a long scan", () => {
    // A 4K desktop has margin to spare; the panel deliberately does not take
    // all of it, or a line of title runs past what the eye tracks in one go.
    expect(box(3840).width).toBe(620);
  });

  it("never leaves the window when the margin runs out", () => {
    // The bug this replaced: keeping the panel glued to the table's edge on a
    // laptop pushed its right half past the screen, where it could not be
    // read or scrolled to.
    for (const laptop of [1000, 1280, 1366, 1470, 1512, 1728, 1920, 2560]) {
      const { left, width } = detailPanelBox(laptop, cardRight(laptop));
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + width).toBeLessThanOrEqual(laptop);
    }
  });

  it("keeps its own width and covers the table rather than shrinking", () => {
    // A covered column can be read by closing the panel; a permanently
    // narrowed table cannot be widened.
    for (const laptop of [1280, 1366, 1470, 1512, 1728]) {
      expect(detailPanelBox(laptop, cardRight(laptop)).width).toBe(340);
    }
    expect(box(1512).overlap).toBe(160);
    expect(box(1728).overlap).toBe(52);
  });

  it("reports overlap as the geometry it actually produced", () => {
    // Derived from left and width, not calculated a second way alongside
    // them — the two disagreed by exactly the gap when they were separate.
    for (const viewport of [1000, 1366, 1512, 1864, 1920, 2208, 3840]) {
      const { left, width, overlap } = detailPanelBox(viewport, cardRight(viewport));
      expect(overlap).toBe(Math.max(0, cardRight(viewport) - left));
      expect(width).toBeGreaterThanOrEqual(340);
    }
  });

  it("has two thresholds, and neither is a cliff", () => {
    const first = (test: (viewport: number) => boolean) => {
      for (let viewport = 1200; viewport <= 2600; viewport += 1) {
        if (test(viewport)) return viewport;
      }
      return 0;
    };
    // Below this the panel starts covering the table's right-hand columns.
    expect(first((viewport) => box(viewport).overlap === 0)).toBe(1832);
    // And below this it is clear of the table but pressed against it, having
    // eaten the gap first. Losing 16px of air is the cheaper concession, so it
    // is the one made first.
    expect(first((viewport) => box(viewport).left >= cardRight(viewport) + 16)).toBe(1864);
    // Just under, and it is one pixel of overlap rather than a jump. An odd
    // window width centres the container on a half pixel, so the walk down is
    // subpixel either way.
    expect(box(1830).overlap).toBe(1);
    expect(box(1831).overlap).toBeGreaterThan(0);
  });
});

describe("windowRowCategory", () => {
  const group = (over: Partial<Parameters<typeof windowRowCategory>[0]> = {}) => ({
    mixed: false,
    categoryId: 1 as number | null,
    categoryName: "AI" as string | null,
    ...over,
  });

  it("says nothing when the window resolves the way its app does", () => {
    // Twenty of Claude's windows all reading "AI" repeats what the
    // Classification section says once, twenty rows running.
    expect(windowRowCategory(group(), 1)).toBeNull();
  });

  it("speaks up when a window has been pulled somewhere else", () => {
    // A Window rule or a correction is the only way this happens, and it is
    // the one thing worth reading in the column.
    expect(windowRowCategory(group({ categoryId: 2, categoryName: "Dev" }), 1)).toBe("Dev");
  });

  it("labels every row when the app has no single category to be silent about", () => {
    expect(windowRowCategory(group(), null)).toBe("AI");
    expect(windowRowCategory(group({ categoryId: null, categoryName: null }), null))
      .toBe("Uncategorized");
  });

  it("always marks a window whose own visits disagree", () => {
    expect(windowRowCategory(group({ mixed: true }), 1)).toBe("Mixed");
  });

  it("marks an uncategorized window inside a categorized app", () => {
    expect(windowRowCategory(group({ categoryId: null, categoryName: null }), 1))
      .toBe("Uncategorized");
  });
});

describe("formatDateSpan", () => {
  const sec = (y: number, m: number, d: number, hour = 0) =>
    new Date(y, m - 1, d, hour).getTime() / 1000;

  it("says the year once when both ends share it", () => {
    expect(formatDateSpan(sec(2026, 6, 28), sec(2026, 7, 27))).toBe("Jun 28 – Jul 27, 2026");
  });

  it("says it twice when they do not", () => {
    expect(formatDateSpan(sec(2025, 12, 30), sec(2026, 1, 2)))
      .toBe("Dec 30, 2025 – Jan 2, 2026");
  });

  it("collapses a range that starts and ends on one date", () => {
    // A day-long range said as "Jul 18 – Jul 18, 2026" reads as a mistake.
    expect(formatDateSpan(sec(2026, 7, 18), sec(2026, 7, 18, 23))).toBe("Jul 18, 2026");
  });

  it("keeps both ends when the dates differ by a day", () => {
    expect(formatDateSpan(sec(2026, 7, 18), sec(2026, 7, 19))).toBe("Jul 18 – Jul 19, 2026");
  });
});

describe("groupVisitsByDay", () => {
  const at = (d: number, hour: number) => ({ start: new Date(2026, 6, d, hour).getTime() / 1000 });

  it("breaks only where the date changes, keeping the order given", () => {
    const days = groupVisitsByDay([at(27, 22), at(27, 10), at(26, 23), at(24, 9)]);
    expect(days.map((day) => day.visits.length)).toEqual([2, 1, 1]);
    // Newest-first in, newest-first out: a heading is a break, not a re-sort.
    expect(days[0].visits[0].start).toBeGreaterThan(days[0].visits[1].start);
  });

  it("keeps midnight-adjacent visits on their own dates", () => {
    const days = groupVisitsByDay([at(27, 0), at(26, 23)]);
    expect(days).toHaveLength(2);
  });

  it("has nothing to group when there are no visits", () => {
    expect(groupVisitsByDay([])).toEqual([]);
  });
});

describe("formatVisitDay", () => {
  const now = new Date(2026, 6, 27, 14, 0);

  it("names the two dates a reader can place without arithmetic", () => {
    expect(formatVisitDay(new Date(2026, 6, 27, 1, 0).getTime() / 1000, now)).toBe("Today");
    expect(formatVisitDay(new Date(2026, 6, 26, 23, 0).getTime() / 1000, now)).toBe("Yesterday");
  });

  it("falls back to the date beyond that", () => {
    expect(formatVisitDay(new Date(2026, 6, 25, 12, 0).getTime() / 1000, now)).toMatch(/25/);
  });
});
