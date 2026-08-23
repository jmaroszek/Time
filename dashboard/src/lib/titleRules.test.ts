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
    pattern: "project atlas",
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

  it("gives one answer whichever stages the scan is able to skip", () => {
    // normalizeWindowTitle skips any stage a scan proves cannot change the
    // string, so each case here reaches a different one and has to agree with
    // the unconditional pipeline it replaced.
    expect(normalizeWindowTitle("Roadmap - Obsidian")).toBe("roadmap - obsidian");
    // Above ASCII, so NFKC runs and nothing else does.
    expect(normalizeWindowTitle("Seeds \u2014 Obsidian")).toBe("seeds \u2014 obsidian");
    // Non-breaking spaces are whitespace the collapse has to reach.
    expect(normalizeWindowTitle("Seeds\u00a0\u00a0\u2014 Obsidian")).toBe("seeds \u2014 obsidian");
    // Fullwidth forms compose down to ASCII, the space among them.
    expect(normalizeWindowTitle("\uff21pp\u3000Name")).toBe("app name");
    // A tab is a control character, replaced before the collapse sees it.
    expect(normalizeWindowTitle("Report\tdraft")).toBe("report draft");
    // Decoration at the start, at the end, and at both.
    expect(normalizeWindowTitle("(12) Inbox")).toBe("inbox");
    expect(normalizeWindowTitle("Notes \u25cf")).toBe("notes");
    expect(normalizeWindowTitle("admin: Notes *")).toBe("notes");
    // A title merely beginning with "a" is not an administrator prefix.
    expect(normalizeWindowTitle("Atlas - Visual Studio Code")).toBe(
      "atlas - visual studio code",
    );
    expect(normalizeWindowTitle("")).toBe("");
    expect(normalizeWindowTitle("   ")).toBe("");
  });

  it("splits visible separators but not a hyphen inside a word", () => {
    expect(splitWindowTitle("roadmap.md - Project Atlas — Obsidian | notes")).toEqual([
      "roadmap.md",
      "project atlas",
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
    expect(matches("Project Atlas (Sandbox) — Obsidian")).toBe(true);
    expect(matches("A project-atlas sandbox")).toBe(true);
    expect(matches("projector atlases")).toBe(false);
    expect(matches("Runtime", { pattern: "time" })).toBe(false);
  });

  it("matches exact normalized title parts and honors position", () => {
    expect(matches("Seeds - Project Atlas - Obsidian", {
      titleMatchMode: "segment",
      titleAnchor: "interior",
    })).toBe(true);
    expect(matches("Project Atlas - Seeds - Obsidian", {
      titleMatchMode: "segment",
      titleAnchor: "interior",
    })).toBe(false);
    expect(matches("Project Atlas (Sandbox) - Obsidian", {
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
    expect(matches("Project Atlas", { scopeKind: "browsers" }, "chrome.exe")).toBe(true);
    expect(matches("Project Atlas", { scopeKind: "browsers" }, "obsidian.exe")).toBe(false);
    expect(matches("Project Atlas", {
      scopeKind: "process",
      scopeValue: "Obsidian.EXE",
    })).toBe(true);
    expect(matches("Project Atlas", {
      scopeKind: "domain",
      scopeValue: "github.com",
    }, "chrome.exe", "gist.github.com")).toBe(true);
    expect(matches("Project Atlas", {
      scopeKind: "domain",
      scopeValue: "github.com",
    }, "chrome.exe", "notgithub.com")).toBe(false);
  });
});
