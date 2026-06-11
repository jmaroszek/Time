import { describe, expect, it } from "vitest";

import { buildClassifier, type Category, type Rule } from "./classify";

const CATS: Category[] = [
  { id: 1, name: "Browsing", color: "#EF9F27", isProductive: true, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "Media", color: "#D4537E", isProductive: false, isIgnored: false, sortOrder: 2 },
  { id: 3, name: "Dev", color: "#378ADD", isProductive: true, isIgnored: false, sortOrder: 3 },
];

const RULES: Rule[] = [
  { id: 1, matchType: "process", pattern: "chrome.exe", categoryId: 1, priority: 100 },
  { id: 2, matchType: "process", pattern: "code.exe", categoryId: 3, priority: 100 },
  { id: 3, matchType: "domain", pattern: "youtube.com", categoryId: 2, priority: 300 },
  { id: 4, matchType: "title", pattern: "netflix", categoryId: 2, priority: 200 },
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
