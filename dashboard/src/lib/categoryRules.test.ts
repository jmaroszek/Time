import { describe, expect, it } from "vitest";

import type { Rule } from "./classify";
import {
  describeTitleRule,
  findDuplicateRule,
  isBuiltInIgnored,
  NEW_CATEGORY_DEFAULT_STATE,
  ruleIdentityKey,
  ruleMatchesSearch,
  sortCategoriesForRules,
  sortRulesForCategory,
  titleRuleScopeLabel,
} from "./categoryRules";
import type { Category } from "./classify";

const rules: Rule[] = [
  {
    id: 1,
    matchType: "domain",
    pattern: "youtube.com",
    categoryId: 4,
    priority: 1,
  },
  {
    id: 2,
    matchType: "title",
    pattern: "grocery list",
    categoryId: 2,
    priority: 2,
    scopeKind: "process",
    scopeValue: "notepad.exe",
    titleMatchMode: "segment",
    titleAnchor: "first",
  },
];

it("defaults a newly named category to neutral", () => {
  expect(NEW_CATEGORY_DEFAULT_STATE).toBe("neutral");
});

describe("ruleIdentityKey", () => {
  it("normalizes pasted websites to the same identity as stored rules", () => {
    expect(ruleIdentityKey("domain", "https://www.YouTube.com/watch?v=1"))
      .toBe(ruleIdentityKey("domain", "youtube.com"));
  });

  it("keeps Window rules with different matching semantics distinct", () => {
    const base = {
      scopeKind: "process" as const,
      scopeValue: "notepad.exe",
      titleMatchMode: "segment" as const,
    };
    expect(ruleIdentityKey("title", "Grocery list", { ...base, titleAnchor: "first" }))
      .not.toBe(ruleIdentityKey("title", "Grocery list", { ...base, titleAnchor: "last" }));
  });
});

describe("findDuplicateRule", () => {
  it("finds the exact stored rule the database would update", () => {
    expect(findDuplicateRule(rules, "domain", "https://youtube.com/feed")?.id).toBe(1);
    expect(findDuplicateRule(rules, "title", "Grocery list", {
      scopeKind: "process",
      scopeValue: "NOTEPAD.EXE",
      titleMatchMode: "segment",
      titleAnchor: "first",
    })?.id).toBe(2);
  });

  it("does not treat a different Window scope as a duplicate", () => {
    expect(findDuplicateRule(rules, "title", "Grocery list", {
      scopeKind: "any",
      scopeValue: "",
      titleMatchMode: "segment",
      titleAnchor: "first",
    })).toBeNull();
  });
});

describe("ruleMatchesSearch", () => {
  it("searches patterns, scopes, and reader-facing rule types", () => {
    expect(ruleMatchesSearch(rules[0], "youtube")).toBe(true);
    expect(ruleMatchesSearch(rules[0], "website")).toBe(true);
    expect(ruleMatchesSearch(rules[1], "notepad")).toBe(true);
    expect(ruleMatchesSearch(rules[1], "window")).toBe(true);
    expect(ruleMatchesSearch(rules[1], "spotify")).toBe(false);
  });

  it("searches every matching-behavior label shown on a Window rule", () => {
    expect(ruleMatchesSearch(rules[1], "exact part")).toBe(true);
    expect(ruleMatchesSearch(rules[1], "start of title")).toBe(true);
    expect(ruleMatchesSearch({
      ...rules[1],
      titleMatchMode: "phrase",
      scopeKind: "browsers",
      scopeValue: "",
    }, "whole words")).toBe(true);
    expect(ruleMatchesSearch({
      ...rules[1],
      titleMatchMode: "contains",
      scopeKind: "any",
      scopeValue: "",
    }, "any app")).toBe(true);
    expect(ruleMatchesSearch({
      ...rules[1],
      titleMatchMode: "contains",
      scopeKind: "browsers",
      scopeValue: "",
    }, "browsers")).toBe(true);
    expect(ruleMatchesSearch({
      ...rules[1],
      scopeKind: "domain",
      scopeValue: "youtube.com",
    }, "website")).toBe(true);
  });

  it("searches legacy Window rules by the defaults displayed on their rows", () => {
    const legacyRule: Rule = {
      id: 3,
      matchType: "title",
      pattern: "standup",
      categoryId: 2,
      priority: 2,
    };
    expect(ruleMatchesSearch(legacyRule, "whole words")).toBe(true);
    expect(ruleMatchesSearch(legacyRule, "any app")).toBe(true);
    expect(ruleMatchesSearch(legacyRule, "exact part")).toBe(false);
  });
});

describe("saved Window rule labels", () => {
  it("uses the builder's words for match behavior", () => {
    expect(describeTitleRule({
      titleMatchMode: "segment",
      titleAnchor: "interior",
    })).toBe("exact part, middle of title");
  });

  it("names broad and specific scopes as they appear on rule rows", () => {
    expect(titleRuleScopeLabel({
      scopeKind: "any",
      scopeValue: "",
    })).toBe("any app");
    expect(titleRuleScopeLabel({
      scopeKind: "domain",
      scopeValue: "youtube.com",
    })).toBe("youtube.com");
  });
});

describe("category and rule ordering", () => {
  const categories: Category[] = [
    { id: 1, name: "Notes", color: "#111", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
    { id: 2, name: "Gaming", color: "#222", isProductive: false, isNeutral: true, isIgnored: false, sortOrder: 2 },
    { id: 3, name: "Browsing", color: "#333", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 3 },
    { id: 4, name: "Ignored", color: "#444", isProductive: false, isNeutral: true, isIgnored: true, sortOrder: 4 },
  ];

  it("sorts categories by name or productivity and pins Ignored last", () => {
    expect(sortCategoriesForRules(categories, "name").map((category) => category.name))
      .toEqual(["Browsing", "Gaming", "Notes", "Ignored"]);
    expect(sortCategoriesForRules(categories, "productivity").map((category) => category.name))
      .toEqual(["Notes", "Gaming", "Browsing", "Ignored"]);
    expect(isBuiltInIgnored(categories[3])).toBe(true);
  });

  it("sorts rules by type and name by default, or by name alone", () => {
    const unsorted: Rule[] = [
      { id: 3, matchType: "process", pattern: "zoom.exe", categoryId: 1, priority: 3 },
      { id: 2, matchType: "domain", pattern: "youtube.com", categoryId: 1, priority: 1 },
      { id: 1, matchType: "domain", pattern: "amazon.com", categoryId: 1, priority: 1 },
      { id: 4, matchType: "title", pattern: "Standup", categoryId: 1, priority: 2 },
    ];
    expect(sortRulesForCategory(unsorted, "type-name").map((rule) => rule.pattern))
      .toEqual(["amazon.com", "youtube.com", "Standup", "zoom.exe"]);
    expect(sortRulesForCategory(unsorted, "name").map((rule) => rule.pattern))
      .toEqual(["amazon.com", "Standup", "youtube.com", "zoom.exe"]);
  });
});
