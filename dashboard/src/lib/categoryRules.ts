import {
  categoryState,
  normalizeRulePattern,
  type Category,
  type MatchType,
  type Productivity,
  type Rule,
  type TitleRuleAnchor,
  type TitleRuleMatchMode,
  type TitleRuleScopeKind,
} from "./classify";
import { normalizeTitleRuleSpec } from "./titleRules";

/** Neutral is the least presumptive judgment for a category the user has only
 * named; productivity becomes an explicit choice rather than a hidden default. */
export const NEW_CATEGORY_DEFAULT_STATE: Productivity = "neutral";

export type CategoryListOrder = "name" | "productivity";
export type RuleListOrder = "type-name" | "name";

/** The seeded category is structural, while an ignored category left behind by
 * an older release is still user-owned. Only the seeded one stays pinned. */
export function isBuiltInIgnored(category: Category): boolean {
  return category.isIgnored && category.name === "Ignored";
}

const compareNames = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

const PRODUCTIVITY_ORDER = {
  productive: 0,
  neutral: 1,
  unproductive: 2,
  ignored: 3,
} as const;

/** The built-in Ignored category is structural rather than a productivity
 * choice, so it stays last in either view. */
export function sortCategoriesForRules(
  categories: Category[],
  order: CategoryListOrder,
): Category[] {
  const pinned = categories.filter(isBuiltInIgnored);
  const ordinary = categories.filter((category) => !isBuiltInIgnored(category));
  if (order === "name") {
    ordinary.sort((left, right) => compareNames(left.name, right.name));
  } else {
    ordinary.sort((left, right) =>
      PRODUCTIVITY_ORDER[categoryState(left)]
      - PRODUCTIVITY_ORDER[categoryState(right)]
      || compareNames(left.name, right.name)
    );
  }
  pinned.sort((left, right) => compareNames(left.name, right.name));
  return [...ordinary, ...pinned];
}

const RULE_TYPE_ORDER: Record<MatchType, number> = {
  domain: 0,
  title: 1,
  process: 2,
};

/** Rule order is visual only; classification continues to use fixed rule
 * precedence. The default mirrors that precedence, then makes each group easy
 * to scan by name. */
export function sortRulesForCategory(
  rules: Rule[],
  order: RuleListOrder,
): Rule[] {
  return [...rules].sort((left, right) => {
    const byName = compareNames(left.pattern, right.pattern);
    if (order === "name") {
      return byName || RULE_TYPE_ORDER[left.matchType] - RULE_TYPE_ORDER[right.matchType];
    }
    return RULE_TYPE_ORDER[left.matchType] - RULE_TYPE_ORDER[right.matchType]
      || byName;
  });
}

export interface RuleIdentityOptions {
  scopeKind?: TitleRuleScopeKind;
  scopeValue?: string;
  titleMatchMode?: TitleRuleMatchMode;
  titleAnchor?: TitleRuleAnchor;
}

/** The words the builder uses for a Window rule's matching behavior. Keeping
 * this beside rule search means every label shown on a saved row is searchable. */
export function describeTitleRule(
  spec: Pick<Rule, "titleMatchMode" | "titleAnchor">,
): string {
  const mode = spec.titleMatchMode ?? "phrase";
  const anchor = spec.titleAnchor ?? "any";
  if (mode === "phrase") return "whole words";
  if (mode === "contains") return "contains";
  if (anchor === "first") return "exact part, start of title";
  if (anchor === "interior") return "exact part, middle of title";
  if (anchor === "last") return "exact part, end of title";
  return "exact part";
}

export function titleRuleScopeLabel(
  rule: Pick<Rule, "scopeKind" | "scopeValue">,
): string {
  if (rule.scopeKind === "domain") return rule.scopeValue ?? "one website";
  if (rule.scopeKind === "process") return rule.scopeValue ?? "one app";
  if (rule.scopeKind === "browsers") return "browsers";
  return "any app";
}

/** Mirrors the columns in the rules uniqueness constraint. The UI uses the
 * same identity as SQLite so a rule move is never disguised as a new rule. */
export function ruleIdentityKey(
  matchType: MatchType,
  pattern: string,
  options: RuleIdentityOptions = {},
): string | null {
  const normalizedPattern = normalizeRulePattern(matchType, pattern);
  if (!normalizedPattern) return null;
  if (matchType !== "title") {
    return JSON.stringify([matchType, normalizedPattern, "", "", "", ""]);
  }
  const spec = normalizeTitleRuleSpec({
    pattern: normalizedPattern,
    scopeKind: options.scopeKind ?? "any",
    scopeValue: options.scopeValue ?? "",
    titleMatchMode: options.titleMatchMode ?? "phrase",
    titleAnchor: options.titleAnchor ?? "any",
  });
  return JSON.stringify([
    matchType,
    spec.pattern,
    spec.scopeKind,
    spec.scopeValue,
    spec.titleMatchMode,
    spec.titleAnchor,
  ]);
}

export function findDuplicateRule(
  rules: Rule[],
  matchType: MatchType,
  pattern: string,
  options: RuleIdentityOptions = {},
): Rule | null {
  const key = ruleIdentityKey(matchType, pattern, options);
  if (!key) return null;
  return rules.find((rule) =>
    ruleIdentityKey(rule.matchType, rule.pattern, {
      scopeKind: rule.scopeKind,
      scopeValue: rule.scopeValue,
      titleMatchMode: rule.titleMatchMode,
      titleAnchor: rule.titleAnchor,
    }) === key
  ) ?? null;
}

const SEARCH_TYPE_LABELS: Record<MatchType, string> = {
  domain: "website domain",
  title: "window title",
  process: "app process",
};

const SEARCH_SCOPE_LABELS: Record<TitleRuleScopeKind, string> = {
  any: "any app",
  browsers: "browsers",
  process: "one app process",
  domain: "website one website domain",
};

/** Search includes the language shown in the UI as well as stored values, so
 * "website" works without requiring the internal word "domain". */
export function ruleMatchesSearch(rule: Rule, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const searchableValues = [
    rule.pattern,
    rule.scopeValue ?? "",
    rule.matchType,
    SEARCH_TYPE_LABELS[rule.matchType],
  ];
  if (rule.matchType === "title") {
    const scopeKind = rule.scopeKind ?? "any";
    searchableValues.push(
      describeTitleRule(rule),
      titleRuleScopeLabel(rule),
      scopeKind,
      SEARCH_SCOPE_LABELS[scopeKind],
    );
  }
  return searchableValues.some((value) =>
    value.toLocaleLowerCase().includes(needle)
  );
}
