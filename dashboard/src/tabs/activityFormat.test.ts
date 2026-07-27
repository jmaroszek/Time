import { describe, expect, it } from "vitest";

import {
  defaultRulePattern,
  describeCorrectionWindow,
  formatLastSeen,
  titleMatchParts,
} from "./ActivityTab";
import { previewTitleRule } from "../lib/titleRuleAnalysis";
import type { Category, Rule, TitleRuleSpec } from "../lib/classify";
import type { ActivitySource } from "../lib/activity";

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
      title.slice(title.indexOf("myrepo") - 16),
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
