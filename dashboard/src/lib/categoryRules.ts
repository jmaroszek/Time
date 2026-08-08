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
import {
  normalizeTitleRuleSpec,
  normalizeWindowTitle,
  splitWindowTitle,
  titlePatternMatches,
} from "./titleRules";

/** Neutral is the least presumptive judgment for a category the user has only
 * named; productivity becomes an explicit choice rather than a hidden default. */
export const NEW_CATEGORY_DEFAULT_STATE: Productivity = "neutral";

export type CategoryListOrder = "name" | "productivity";
export type RuleListOrder = "type-name" | "name" | "use";

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
 * to scan by name.
 *
 * `usageSeconds` is how much of all history each rule actually decided, and is
 * only consulted by the "use" order. It is absent until the sessions have been
 * read, which falls back to the default order rather than to an arbitrary one:
 * a list that claims to be sorted by use before anything is known about use
 * would be sorted by nothing at all. */
export function sortRulesForCategory(
  rules: Rule[],
  order: RuleListOrder,
  usageSeconds?: ReadonlyMap<number, number> | null,
): Rule[] {
  return [...rules].sort((left, right) => {
    const byName = compareNames(left.pattern, right.pattern);
    const byType = RULE_TYPE_ORDER[left.matchType] - RULE_TYPE_ORDER[right.matchType];
    if (order === "use" && usageSeconds) {
      // Heaviest first, and every unused rule collects at the bottom — which is
      // the pile this order exists to find. Ties fall through to the default,
      // so the many rules sharing a total of zero stay in a readable order.
      const byUse = (usageSeconds.get(right.id) ?? 0) - (usageSeconds.get(left.id) ?? 0);
      if (byUse !== 0) return byUse;
    } else if (order === "name") {
      return byName || byType;
    }
    return byType || byName;
  });
}

export interface RuleIdentityOptions {
  scopeKind?: TitleRuleScopeKind;
  scopeValue?: string;
  titleMatchMode?: TitleRuleMatchMode;
  titleAnchor?: TitleRuleAnchor;
}

export const TITLE_MATCH_MODE_OPTIONS: ReadonlyArray<{
  value: TitleRuleMatchMode;
  label: string;
}> = [
  { value: "contains", label: "Text fragment" },
  { value: "phrase", label: "Word phrase" },
  { value: "segment", label: "Whole section" },
];

/** A stable explanation belongs beside the mode even when a narrow scope makes
 * the rule reasonable. Scope can reduce reach; it cannot change how text is
 * compared or make a substring stop matching inside a longer word. */
export function titleMatchModeHelp(mode: TitleRuleMatchMode): string {
  if (mode === "contains") {
    return "Matches anywhere in the normalized title, including inside longer words.";
  }
  if (mode === "phrase") {
    return "Matches the same consecutive whole words; punctuation and title separators count as word boundaries.";
  }
  return "Matches one complete title section separated by marks such as “ — ”, “ - ”, or “ | ”.";
}

/** Explain the current rule against the concrete title that opened the dialog.
 * Counts describe historical reach; this line teaches the text semantics that
 * produced the count, including an anchor retained by a generated or old rule. */
export function explainTitleMatchAgainstTitle(
  spec: Pick<Rule, "pattern" | "titleMatchMode" | "titleAnchor">,
  title: string,
): string {
  const pattern = normalizeWindowTitle(spec.pattern);
  if (!pattern) return "Enter text to see how it matches this title.";

  const mode = spec.titleMatchMode ?? "phrase";
  const anchor = spec.titleAnchor ?? "any";
  const matches = titlePatternMatches({
    pattern,
    titleMatchMode: mode,
    titleAnchor: anchor,
  }, title);

  if (mode === "contains") {
    return matches
      ? `Matches “${pattern}” as a text fragment. Text fragments can also match inside longer words.`
      : `Does not contain “${pattern}” as a text fragment.`;
  }
  if (mode === "phrase") {
    return matches
      ? `Matches “${pattern}” as consecutive whole words. Punctuation and title separators count as word boundaries.`
      : `Does not contain “${pattern}” as the same consecutive whole words.`;
  }

  const sections = splitWindowTitle(title);
  if (anchor === "interior" && sections.length < 3) {
    return "Does not match: this title has no interior section between its first and last sections.";
  }
  const position = anchor === "first"
    ? "the first"
    : anchor === "interior"
      ? "an interior"
      : anchor === "last"
        ? "the last"
        : "a complete";
  return matches
    ? `Matches “${pattern}” as ${position} title section.`
    : `Does not match ${position} title section exactly.`;
}

/** The words the builder uses for a Window rule's matching behavior. Keeping
 * this beside rule search means every label shown on a saved row is searchable. */
export function describeTitleRule(
  spec: Pick<Rule, "titleMatchMode" | "titleAnchor">,
): string {
  const mode = spec.titleMatchMode ?? "phrase";
  const anchor = spec.titleAnchor ?? "any";
  if (mode === "phrase") return "word phrase";
  if (mode === "contains") return "text fragment";
  if (anchor === "first") return "whole section, first in title";
  if (anchor === "interior") return "whole section, interior in title";
  if (anchor === "last") return "whole section, last in title";
  return "whole section";
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
