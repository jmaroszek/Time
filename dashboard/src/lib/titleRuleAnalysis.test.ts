import { describe, expect, it } from "vitest";

import type { ActivitySource } from "./activity";
import type { Category, Rule } from "./classify";
import { suggestTitleRuleCandidates } from "./titleRuleAnalysis";
import { containsVersion } from "./titleRules";

const categories: Category[] = [
  {
    id: 1,
    name: "Notes",
    color: "#111",
    isProductive: true,
    isNeutral: false,
    isIgnored: false,
    sortOrder: 1,
  },
];
const rules: Rule[] = [
  { id: 1, matchType: "process", pattern: "obsidian.exe", categoryId: 1, priority: 3 },
];
const session = (
  id: number,
  day: number,
  title: string,
  process = "obsidian.exe",
) => ({
  id,
  start: new Date(2026, 6, day, 9).getTime() / 1000,
  end: new Date(2026, 6, day, 10).getTime() / 1000,
  process,
  title,
  domain: null,
  isAfk: false,
});

describe("suggestTitleRuleCandidates", () => {
  it("uses history to prefer a recurring context over the current document", () => {
    const source: ActivitySource = {
      categories,
      rules,
      browserProcesses: ["chrome.exe"],
      aliases: {},
      sessions: [
        session(1, 1, "Seeds - Garden - Obsidian 1.12.4"),
        session(2, 2, "Watering - Garden - Obsidian 1.12.4"),
        session(3, 3, "Harvest - Garden - Obsidian 1.12.7"),
        session(4, 4, "Budget - Finance - Obsidian 1.12.7"),
      ],
    };
    const candidates = suggestTitleRuleCandidates(
      source,
      "Seeds - Garden - Obsidian 1.12.4",
      { scopeKind: "process", scopeValue: "obsidian.exe" },
      ["Obsidian"],
    );
    expect(candidates[0]?.pattern).toBe("garden");
    expect(candidates[0]?.days).toBe(3);
    expect(candidates.some((candidate) => containsVersion(candidate.pattern))).toBe(false);
    expect(candidates.some((candidate) => candidate.pattern.includes("obsidian"))).toBe(false);
  });

  it("does not offer a Window rule that reaches nearly every window in scope", () => {
    const source: ActivitySource = {
      categories,
      rules,
      browserProcesses: [],
      aliases: {},
      sessions: [
        session(1, 1, "One - Antigravity"),
        session(2, 2, "Two - Antigravity"),
        session(3, 3, "Three - Antigravity"),
      ],
    };
    const candidates = suggestTitleRuleCandidates(
      source,
      "One - Antigravity",
      { scopeKind: "process", scopeValue: "antigravity.exe" },
      ["Antigravity"],
    );
    expect(candidates.some((candidate) => candidate.pattern === "antigravity")).toBe(false);
  });
});
