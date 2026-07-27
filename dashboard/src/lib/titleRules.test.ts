import { describe, expect, it } from "vitest";

import {
  containsVersion,
  normalizeWindowTitle,
  splitWindowTitle,
  titleRuleMatches,
  type TitleRuleSpec,
} from "./titleRules";

const BROWSERS = new Set(["chrome.exe", "firefox.exe"]);
const matches = (
  title: string,
  over: Partial<TitleRuleSpec> = {},
  process = "obsidian.exe",
  domain: string | null = null,
) => titleRuleMatches(
  {
    pattern: "skill tree",
    scopeKind: "any",
    scopeValue: "",
    titleMatchMode: "phrase",
    titleAnchor: "any",
    ...over,
  },
  { process, title, domain },
  BROWSERS,
);

describe("Windows title normalization", () => {
  it("strips volatile Windows/app decorations and normalizes Unicode spacing", () => {
    expect(normalizeWindowTitle("(3)  ●  Seeds　—  Obsidian  ")).toBe(
      "seeds — obsidian",
    );
    expect(normalizeWindowTitle("Administrator: PowerShell *")).toBe("powershell");
    expect(normalizeWindowTitle("*Untitled - Notepad")).toBe("untitled - notepad");
  });

  it("splits visible separators but not a hyphen inside a word", () => {
    expect(splitWindowTitle("roadmap.md - Skill Tree — Obsidian | notes")).toEqual([
      "roadmap.md",
      "skill tree",
      "obsidian",
      "notes",
    ]);
    expect(splitWindowTitle("well-known things")).toEqual(["well-known things"]);
  });

  it("recognizes version-bearing parts without treating ordinary numbers as versions", () => {
    expect(containsVersion("Obsidian 1.12.7")).toBe(true);
    expect(containsVersion("Visual Studio Code v2.4")).toBe(true);
    expect(containsVersion("Issue 123")).toBe(false);
  });
});

describe("Window rule meanings", () => {
  it("matches a contiguous whole-word phrase without matching inside longer words", () => {
    expect(matches("Skill Tree (Sandbox) — Obsidian")).toBe(true);
    expect(matches("A skill-tree sandbox")).toBe(true);
    expect(matches("skillful treehouse")).toBe(false);
    expect(matches("Runtime", { pattern: "time" })).toBe(false);
  });

  it("matches exact normalized title parts and honors position", () => {
    expect(matches("Seeds - Skill Tree - Obsidian", {
      titleMatchMode: "segment",
      titleAnchor: "interior",
    })).toBe(true);
    expect(matches("Skill Tree - Seeds - Obsidian", {
      titleMatchMode: "segment",
      titleAnchor: "interior",
    })).toBe(false);
    expect(matches("Skill Tree (Sandbox) - Obsidian", {
      titleMatchMode: "segment",
      titleAnchor: "first",
    })).toBe(false);
  });

  it("keeps raw substring behavior explicit", () => {
    expect(matches("Runtime", {
      pattern: "time",
      titleMatchMode: "contains",
    })).toBe(true);
  });

  it("supports any-app, browser, process, and website scopes", () => {
    expect(matches("Skill Tree", { scopeKind: "browsers" }, "chrome.exe")).toBe(true);
    expect(matches("Skill Tree", { scopeKind: "browsers" }, "obsidian.exe")).toBe(false);
    expect(matches("Skill Tree", {
      scopeKind: "process",
      scopeValue: "Obsidian.EXE",
    })).toBe(true);
    expect(matches("Skill Tree", {
      scopeKind: "domain",
      scopeValue: "github.com",
    }, "chrome.exe", "gist.github.com")).toBe(true);
    expect(matches("Skill Tree", {
      scopeKind: "domain",
      scopeValue: "github.com",
    }, "chrome.exe", "notgithub.com")).toBe(false);
  });
});
