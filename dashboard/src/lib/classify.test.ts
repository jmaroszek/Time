import { describe, expect, it } from "vitest";

import {
  buildClassifier,
  categoryKind,
  categoryState,
  categoryStateFlags,
  normalizeRulePattern,
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
  { id: 4, matchType: "title", pattern: "netflix", categoryId: 2, priority: 2 },
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

  it("title and domain rules do not apply to non-browsers", () => {
    expect(classify(session({ process: "code.exe", title: "netflix clone project" }))?.name).toBe(
      "Dev",
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
