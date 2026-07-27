import { describe, expect, it } from "vitest";

import {
  buildClassifier,
  buildClassificationExplainer,
  categoryKind,
  categoryState,
  categoryStateFlags,
  normalizeRulePattern,
  memoizeClassifierById,
  type Category,
  type Rule,
} from "./classify";

const CATS: Category[] = [
  { id: 1, name: "Browsing", color: "#EF9F27", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Media", color: "#D4537E", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Dev", color: "#378ADD", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 3 },
];

const RULES: Rule[] = [
  { id: 1, matchType: "process", pattern: "chrome.exe", categoryId: 1, priority: 3 },
  { id: 2, matchType: "process", pattern: "code.exe", categoryId: 3, priority: 3 },
  { id: 3, matchType: "domain", pattern: "youtube.com", categoryId: 2, priority: 1 },
  {
    id: 4,
    matchType: "title",
    pattern: "netflix",
    categoryId: 2,
    priority: 2,
    scopeKind: "any",
    scopeValue: "",
    titleMatchMode: "phrase",
    titleAnchor: "any",
  },
];

const BROWSERS = new Set(["chrome.exe"]);

const classify = buildClassifier(CATS, RULES, BROWSERS);

const session = (over: Partial<Parameters<typeof classify>[0]>) => ({
  process: "chrome.exe",
  title: "",
  domain: null,
  isAfk: false,
  ...over,
});

describe("buildClassifier", () => {
  it("matches process rules", () => {
    expect(classify(session({ process: "code.exe" }))?.name).toBe("Dev");
  });

  it("domain rule outranks process rule for browsers", () => {
    expect(classify(session({ domain: "youtube.com" }))?.name).toBe("Media");
  });

  it("matches subdomains", () => {
    expect(classify(session({ domain: "music.youtube.com" }))?.name).toBe("Media");
  });

  it("does not match partial domain suffixes", () => {
    expect(classify(session({ domain: "notyoutube.com" }))?.name).toBe("Browsing");
  });

  it("title rule outranks process rule for browsers", () => {
    expect(classify(session({ title: "Watching Netflix - Chrome" }))?.name).toBe("Media");
  });

  it("title rules are case-insensitive", () => {
    expect(classify(session({ title: "NETFLIX home" }))?.name).toBe("Media");
  });

  it("domain rules do not apply to non-browsers", () => {
    expect(classify(session({ process: "code.exe", domain: "youtube.com" }))?.name).toBe("Dev");
  });

  it("an unscoped title rule reaches past the browser", () => {
    // The reason the scope exists: "netflix" in an editor window is a project
    // named after it, not the site. An unscoped rule cannot tell the
    // difference, and outranks the App rule that would have said Dev.
    expect(classify(session({ process: "code.exe", title: "netflix clone project" }))?.name).toBe(
      "Media",
    );
  });

  it("unknown process is uncategorized", () => {
    expect(classify(session({ process: "mystery.exe" }))).toBeNull();
  });

  it("afk sessions are never classified", () => {
    expect(classify(session({ isAfk: true }))).toBeNull();
  });

  it("process match is case-insensitive", () => {
    expect(classify(session({ process: "Chrome.EXE" }))?.name).toBe("Browsing");
  });

  it("prefers the more specific domain when suffix rules overlap", () => {
    const tied = buildClassifier(
      CATS,
      [
        { id: 10, matchType: "domain", pattern: "youtube.com", categoryId: 1, priority: 1 },
        { id: 11, matchType: "domain", pattern: "music.youtube.com", categoryId: 2, priority: 1 },
      ],
      BROWSERS,
    );
    expect(tied(session({ domain: "music.youtube.com" }))?.name).toBe("Media");
  });
});

describe("title rule scope", () => {
  const scoped = (
    scopeKind: "any" | "browsers" | "process" | "domain",
    scopeValue = "",
    categoryId = 2,
  ): Rule[] => [
    ...RULES.filter((rule) => rule.matchType === "process"),
    {
      id: 20,
      matchType: "title",
      pattern: "journal",
      categoryId,
      priority: scopeKind === "domain" ? 0 : 2,
      scopeKind,
      scopeValue,
      titleMatchMode: "phrase",
      titleAnchor: "any",
    },
  ];
  const at = (rules: Rule[], process: string) =>
    buildClassifier(CATS, rules, BROWSERS)(session({ process, title: "Work journal — notes" }))?.name;

  it("'any' matches whatever program is in front", () => {
    expect(at(scoped("any"), "chrome.exe")).toBe("Media");
    expect(at(scoped("any"), "obsidian.exe")).toBe("Media");
  });

  it("'browsers' matches any configured browser and nothing else", () => {
    expect(at(scoped("browsers"), "chrome.exe")).toBe("Media");
    // Falls through to the App rule rather than matching.
    expect(at(scoped("browsers"), "code.exe")).toBe("Dev");
  });

  it("a process scope matches only that executable", () => {
    expect(at(scoped("process", "obsidian.exe"), "obsidian.exe")).toBe("Media");
    expect(at(scoped("process", "obsidian.exe"), "chrome.exe")).toBe("Browsing");
  });

  it("scopes are matched case-insensitively, like every other pattern", () => {
    expect(at(scoped("process", "Obsidian.EXE"), "obsidian.exe")).toBe("Media");
  });

  it("an absent scope reads as any-app for in-memory callers", () => {
    const legacy: Rule[] = [{ id: 21, matchType: "title", pattern: "journal", categoryId: 2, priority: 2 }];
    expect(at(legacy, "obsidian.exe")).toBe("Media");
  });

  it("gives the narrower scope the win when two title rules tie on priority", () => {
    // Array order puts the broad rule first, so without the specificity
    // tiebreak the winner would be whichever was inserted first — invisible
    // to anyone reading the rule list.
    const both: Rule[] = [
      {
        id: 30, matchType: "title", pattern: "journal", categoryId: 2, priority: 2,
        scopeKind: "any", scopeValue: "", titleMatchMode: "phrase", titleAnchor: "any",
      },
      {
        id: 31, matchType: "title", pattern: "journal", categoryId: 3, priority: 2,
        scopeKind: "process", scopeValue: "obsidian.exe",
        titleMatchMode: "phrase", titleAnchor: "any",
      },
    ];
    expect(at(both, "obsidian.exe")).toBe("Dev");
    expect(at(both, "chrome.exe")).toBe("Media");
    // And the same holds when the narrow rule is listed first.
    expect(at([both[1], both[0]], "obsidian.exe")).toBe("Dev");
  });

  it("prefers a browser scope over no scope at all", () => {
    const both: Rule[] = [
      {
        id: 40, matchType: "title", pattern: "journal", categoryId: 2, priority: 2,
        scopeKind: "any", scopeValue: "", titleMatchMode: "phrase", titleAnchor: "any",
      },
      {
        id: 41, matchType: "title", pattern: "journal", categoryId: 3, priority: 2,
        scopeKind: "browsers", scopeValue: "", titleMatchMode: "phrase", titleAnchor: "any",
      },
    ];
    expect(at(both, "chrome.exe")).toBe("Dev");
    expect(at(both, "obsidian.exe")).toBe("Media");
  });

  it("a general title still loses to a Website rule", () => {
    const rules: Rule[] = [
      { id: 50, matchType: "domain", pattern: "youtube.com", categoryId: 2, priority: 1 },
      {
        id: 51, matchType: "title", pattern: "journal", categoryId: 3, priority: 2,
        scopeKind: "process", scopeValue: "chrome.exe",
        titleMatchMode: "phrase", titleAnchor: "any",
      },
    ];
    const explain = buildClassificationExplainer(CATS, rules, BROWSERS);
    const result = explain(session({ domain: "youtube.com", title: "Work journal" }));
    expect(result.category?.name).toBe("Media");
    expect(result.winningRule?.matchType).toBe("domain");
  });

  it("a title scoped to that website can refine its Website rule", () => {
    const rules: Rule[] = [
      { id: 52, matchType: "domain", pattern: "youtube.com", categoryId: 2, priority: 1 },
      {
        id: 53, matchType: "title", pattern: "journal", categoryId: 3, priority: 0,
        scopeKind: "domain", scopeValue: "youtube.com",
        titleMatchMode: "phrase", titleAnchor: "any",
      },
    ];
    const result = buildClassificationExplainer(CATS, rules, BROWSERS)(
      session({ domain: "music.youtube.com", title: "Work journal" }),
    );
    expect(result.category?.name).toBe("Dev");
    expect(result.winningRule?.id).toBe(53);
  });

  it("does not match a session with no stored title", () => {
    expect(buildClassifier(CATS, scoped("any"), BROWSERS)(
      session({ process: "obsidian.exe", title: "" }),
    )).toBeNull();
  });
});

describe("buildClassificationExplainer", () => {
  const explain = buildClassificationExplainer(CATS, RULES, BROWSERS);

  it("returns the category and winning rule", () => {
    const result = explain(session({ domain: "music.youtube.com", title: "Netflix" }));
    expect(result.category?.name).toBe("Media");
    expect(result.winningRule?.matchType).toBe("domain");
    expect(result.winningRule?.pattern).toBe("youtube.com");
  });

  it("returns an empty explanation for uncategorized and AFK sessions", () => {
    expect(explain(session({ process: "unknown.exe" }))).toEqual({
      category: null,
      winningRule: null,
      source: "none",
    });
    expect(explain(session({ isAfk: true }))).toEqual({
      category: null,
      winningRule: null,
      source: "none",
    });
  });

  it("uses a session override before every rule", () => {
    const result = explain(session({ domain: "youtube.com", categoryOverrideId: 3 }));
    expect(result.category?.name).toBe("Dev");
    expect(result.winningRule).toBeNull();
    expect(result.source).toBe("session_override");
  });
});

describe("memoizeClassifierById", () => {
  it("classifies clipped copies of one row only once", () => {
    let calls = 0;
    const memoized = memoizeClassifierById((value) => {
      calls += 1;
      return value.isAfk ? null : CATS[0];
    });
    const first = { id: 42, ...session({}) };
    expect(memoized(first)).toBe(CATS[0]);
    expect(memoized({ ...first, title: "a clipped copy" })).toBe(CATS[0]);
    expect(calls).toBe(1);
  });

  it("bypasses the cache for samples without a database id", () => {
    let calls = 0;
    const memoized = memoizeClassifierById(() => {
      calls += 1;
      return null;
    });
    memoized(session({}));
    memoized(session({}));
    expect(calls).toBe(2);
  });

  it("reclassifies a session id when its override changes", () => {
    let calls = 0;
    const memoized = memoizeClassifierById((value) => {
      calls += 1;
      return value.categoryOverrideId === 2 ? CATS[1] : CATS[0];
    });
    const original = { id: 9, ...session({}) };
    expect(memoized(original)).toBe(CATS[0]);
    expect(memoized({ ...original, categoryOverrideId: 2 })).toBe(CATS[1]);
    expect(calls).toBe(2);
  });
});

describe("categoryKind", () => {
  const base: Category = {
    id: 1,
    name: "X",
    color: "#000",
    isProductive: false,
    isNeutral: false,
    isIgnored: false,
    sortOrder: 1,
  };

  it("reads the productivity state off the flags", () => {
    expect(categoryKind({ ...base, isProductive: true })).toBe("productive");
    expect(categoryKind({ ...base, isNeutral: true })).toBe("neutral");
    expect(categoryKind(base)).toBe("unproductive");
  });

  it("prefers productive when both flags are somehow set", () => {
    expect(categoryKind({ ...base, isProductive: true, isNeutral: true })).toBe("productive");
  });
});

describe("categoryState / categoryStateFlags", () => {
  const base: Category = {
    id: 1,
    name: "X",
    color: "#000",
    isProductive: false,
    isNeutral: false,
    isIgnored: false,
    sortOrder: 1,
  };

  it("ignored overrides productivity when reading state", () => {
    expect(categoryState({ ...base, isProductive: true, isIgnored: true })).toBe("ignored");
    expect(categoryState({ ...base, isProductive: true })).toBe("productive");
    expect(categoryState({ ...base, isNeutral: true })).toBe("neutral");
    expect(categoryState(base)).toBe("unproductive");
  });

  it("productivity states clear the ignored flag", () => {
    expect(categoryStateFlags("neutral")).toEqual({
      isProductive: false,
      isNeutral: true,
      isIgnored: false,
    });
  });

  it("ignored only sets isIgnored, preserving underlying productivity", () => {
    // Spreading onto a productive category keeps it productive under the hood.
    const merged = { ...base, isProductive: true, ...categoryStateFlags("ignored") };
    expect(merged.isIgnored).toBe(true);
    expect(merged.isProductive).toBe(true);
    expect(categoryState(merged)).toBe("ignored");
  });
});

describe("normalizeRulePattern", () => {
  it("reduces a pasted URL to the bare domain", () => {
    expect(normalizeRulePattern("domain", "https://www.EXAMPLE.com/path?q=1")).toBe("example.com");
  });

  it("strips scheme, port, userinfo, fragment, and stray dots", () => {
    expect(normalizeRulePattern("domain", "http://example.com:8080/x")).toBe("example.com");
    expect(normalizeRulePattern("domain", "https://user@example.com/")).toBe("example.com");
    expect(normalizeRulePattern("domain", "example.com#section")).toBe("example.com");
    expect(normalizeRulePattern("domain", "example.com.")).toBe("example.com");
  });

  it("keeps non-www subdomains (suffix matching handles the rest)", () => {
    expect(normalizeRulePattern("domain", "music.youtube.com")).toBe("music.youtube.com");
    expect(normalizeRulePattern("domain", "www.music.youtube.com")).toBe("music.youtube.com");
  });

  it("passes bare domains through unchanged", () => {
    expect(normalizeRulePattern("domain", "youtube.com")).toBe("youtube.com");
  });

  it("returns null when nothing matchable remains", () => {
    expect(normalizeRulePattern("domain", "https://")).toBeNull();
    expect(normalizeRulePattern("domain", "   ")).toBeNull();
    expect(normalizeRulePattern("title", "  ")).toBeNull();
  });

  it("lowercases and trims title and process patterns without URL surgery", () => {
    expect(normalizeRulePattern("title", "  NetFlix  ")).toBe("netflix");
    expect(normalizeRulePattern("process", "Chrome.EXE")).toBe("chrome.exe");
    // A slash in a title pattern is content, not a URL path.
    expect(normalizeRulePattern("title", "a/b")).toBe("a/b");
  });
});
