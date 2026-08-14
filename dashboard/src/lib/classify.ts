// Rule-based session classification. Website rules beat general Window rules,
// Window rules beat App rules, and a Window rule scoped to one website may
// refine that Website rule. AFK sessions are never classified.

import {
  ANY_APP,
  normalizeWindowTitle,
  prepareTitleRule,
  preparedTitleRuleMatches,
  SessionTitle,
  titleMatchSpecificity,
  titleScopeSpecificity,
  type PreparedTitleRule,
  type TitleRuleAnchor,
  type TitleRuleMatchMode,
  type TitleRuleScopeKind,
  type TitleRuleSpec,
} from "./titleRules";

export { ANY_APP, BROWSER_SCOPE } from "./titleRules";
export type {
  TitleRuleAnchor,
  TitleRuleMatchMode,
  TitleRuleScopeKind,
  TitleRuleSpec,
} from "./titleRules";

/** Three-way productivity state. Neutral time (e.g. games) is tracked but is
 *  never colored good/bad — it counts toward totals without being judged. */
export type Productivity = "productive" | "neutral" | "unproductive";

export interface Category {
  id: number;
  name: string;
  color: string;
  isProductive: boolean;
  /** Neutral categories are neither productive nor unproductive. Mutually
   *  exclusive with isProductive. */
  isNeutral: boolean;
  /** Ignored categories are hidden from every visualization. */
  isIgnored: boolean;
  sortOrder: number | null;
}

/** Collapse the two flags into the single productivity state. */
export function categoryKind(cat: Category): Productivity {
  if (cat.isProductive) return "productive";
  if (cat.isNeutral) return "neutral";
  return "unproductive";
}

/** The full editable state of a category: its productivity, or "ignored"
 *  (which hides it everywhere and takes precedence over productivity). */
export type CategoryState = Productivity | "ignored";

export function categoryState(cat: Category): CategoryState {
  return cat.isIgnored ? "ignored" : categoryKind(cat);
}

/** The three flags a chosen state implies. "ignored" only sets isIgnored,
 *  preserving the underlying productivity so toggling back restores it. */
export function categoryStateFlags(
  state: CategoryState,
): Pick<Category, "isProductive" | "isNeutral" | "isIgnored"> | Pick<Category, "isIgnored"> {
  switch (state) {
    case "productive":
      return { isProductive: true, isNeutral: false, isIgnored: false };
    case "neutral":
      return { isProductive: false, isNeutral: true, isIgnored: false };
    case "unproductive":
      return { isProductive: false, isNeutral: false, isIgnored: false };
    case "ignored":
      return { isIgnored: true };
  }
}

export type MatchType = "process" | "domain" | "title";

/** The priority a rule is stored with when nothing overrides it: Website beats
 *  Window beats App. Shared with the rule preview so a previewed rule contends
 *  on exactly the terms the saved one will. `effectivePriority` below still
 *  demotes a website-scoped Window rule past all three at match time. */
export const DEFAULT_RULE_PRIORITY: Record<MatchType, number> = {
  domain: 1,
  title: 2,
  process: 3,
};

export interface Rule {
  id: number;
  matchType: MatchType;
  pattern: string;
  categoryId: number;
  priority: number;
  /** Window-only fields. The schema requires all four together for title
   * rules and empty values for App/Website rules. They stay optional here so
   * test fixtures and callers constructing non-title rules need not repeat
   * fields that cannot affect them. */
  scopeKind?: TitleRuleScopeKind;
  scopeValue?: string;
  titleMatchMode?: TitleRuleMatchMode;
  titleAnchor?: TitleRuleAnchor;
}

/** Normalize a user-entered rule pattern into a matchable one, or null when
 *  nothing matchable remains. Domain patterns accept a pasted URL and reduce
 *  it to the bare host — mirrors tracker/domains.py `_clean_host`, which is
 *  what produces the `domain` values these rules compare against. */
export function normalizeRulePattern(matchType: MatchType, raw: string): string | null {
  let pat = matchType === "title"
    ? normalizeWindowTitle(raw)
    : raw.toLowerCase().trim();
  if (matchType !== "domain") return pat || null;
  pat = pat.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  pat = pat.split(/[/?#]/)[0]; // path / query / fragment
  const at = pat.lastIndexOf("@"); // userinfo (rare, but a valid URL part)
  if (at !== -1) pat = pat.slice(at + 1);
  pat = pat.split(":")[0]; // port
  pat = pat.replace(/^\.+|\.+$/g, ""); // stray dots
  if (pat.startsWith("www.")) pat = pat.slice(4);
  return pat || null;
}

export interface Classifiable {
  process: string;
  title: string;
  domain: string | null;
  isAfk: boolean;
  categoryOverrideId?: number | null;
}

export type ClassificationSource = "rule" | "session_override" | "none";

export type Classifier = (s: Classifiable) => Category | null;

export interface ClassificationExplanation {
  category: Category | null;
  winningRule: Rule | null;
  source: ClassificationSource;
}

export type ClassificationExplainer = (s: Classifiable) => ClassificationExplanation;

/** Cache classification across clipped copies of the same database row. The
 *  wrapper is recreated with the underlying classifier, so category/rule edits
 *  invalidate every entry automatically. Non-session samples still work and
 *  simply bypass the id cache. */
export function memoizeClassifierById(classifier: Classifier): Classifier {
  const categoryById = new Map<number, {
    overrideId: number | null;
    category: Category | null;
  }>();
  return (session: Classifiable): Category | null => {
    const id = (session as Classifiable & { id?: unknown }).id;
    if (typeof id !== "number") return classifier(session);
    const overrideId = session.categoryOverrideId ?? null;
    const cached = categoryById.get(id);
    if (cached && cached.overrideId === overrideId) return cached.category;
    const category = classifier(session);
    categoryById.set(id, { overrideId, category });
    return category;
  };
}

export function buildClassifier(
  categories: Category[],
  rules: Rule[],
  browserProcesses: Set<string>,
): Classifier {
  const explain = buildClassificationExplainer(categories, rules, browserProcesses);
  return (session) => explain(session).category;
}

/** Build the same classifier used by Insights while retaining the winning
 * rule. Activity uses the explanation to make global classification changes
 * inspectable; keeping the matcher shared prevents the two tabs disagreeing. */
export function buildClassificationExplainer(
  categories: Category[],
  rules: Rule[],
  browserProcesses: Set<string>,
): ClassificationExplainer {
  const catById = new Map(categories.map((c) => [c.id, c]));
  type NormalizedRule = Rule & TitleRuleSpec;
  type Candidate = { rule: NormalizedRule; order: number };
  /** A Window rule keeps the prepared form of itself: pattern normalization is
   *  the bulk of matching, and doing it here rather than per session is what
   *  keeps the cost of classifying a database flat in the number of rules. */
  type TitleCandidate = Candidate & { prepared: PreparedTitleRule };
  const processRules = new Map<string, Candidate>();
  const domainRules = new Map<string, Candidate>();
  const titleRules: TitleCandidate[] = [];
  const effectivePriority = (candidate: Candidate): number =>
    candidate.rule.matchType === "title" && candidate.rule.scopeKind === "domain"
      ? 0
      : candidate.rule.priority;
  const prefer = (left: Candidate | undefined, right: Candidate): Candidate =>
    !left || effectivePriority(right) < effectivePriority(left) ? right : left;
  for (const [order, r] of rules.entries()) {
    // The prepared rule is what the matcher reads. `rule` keeps only its spec
    // half, because that one is reported as `winningRule` and a token list is
    // no business of the caller's.
    const prepared = prepareTitleRule({
      pattern: r.pattern,
      scopeKind: r.scopeKind ?? ANY_APP,
      scopeValue: r.scopeValue ?? "",
      titleMatchMode: r.titleMatchMode ?? "phrase",
      titleAnchor: r.titleAnchor ?? "any",
    });
    const { patternTokens, ...titleSpec } = prepared;
    const candidate = {
      rule: {
        ...r,
        ...titleSpec,
        pattern: r.matchType === "title"
          ? titleSpec.pattern
          : r.pattern.toLowerCase(),
      },
      order,
    };
    if (r.matchType === "process") {
      processRules.set(candidate.rule.pattern, prefer(processRules.get(candidate.rule.pattern), candidate));
    } else if (r.matchType === "domain") {
      domainRules.set(candidate.rule.pattern, prefer(domainRules.get(candidate.rule.pattern), candidate));
    } else {
      titleRules.push({ ...candidate, prepared });
    }
  }

  return (s: Classifiable): ClassificationExplanation => {
    if (s.isAfk) return { category: null, winningRule: null, source: "none" };
    if (s.categoryOverrideId != null) {
      return {
        category: catById.get(s.categoryOverrideId) ?? null,
        winningRule: null,
        source: catById.has(s.categoryOverrideId) ? "session_override" : "none",
      };
    }
    let best: Candidate | null = null;
    const consider = (candidate: Candidate | undefined) => {
      if (candidate && (!best || effectivePriority(candidate) < effectivePriority(best))) {
        best = candidate;
      }
    };

    const proc = s.process.toLowerCase();
    consider(processRules.get(proc));

    if (browserProcesses.has(proc)) {
      const domain = s.domain?.toLowerCase() ?? null;
      if (domain) {
        let suffix = domain;
        let domainBest: Candidate | undefined;
        while (suffix) {
          const candidate = domainRules.get(suffix);
          if (
            candidate &&
            (!domainBest ||
              effectivePriority(candidate) < effectivePriority(domainBest) ||
              (effectivePriority(candidate) === effectivePriority(domainBest) &&
                candidate.rule.pattern.length > domainBest.rule.pattern.length) ||
              (effectivePriority(candidate) === effectivePriority(domainBest) &&
                candidate.rule.pattern.length === domainBest.rule.pattern.length &&
                candidate.order < domainBest.order))
          ) {
            domainBest = candidate;
          }
          const dot = suffix.indexOf(".");
          if (dot < 0) break;
          suffix = suffix.slice(dot + 1);
        }
        consider(domainBest);
      }
    }

    // Outside the browser block: a stored title belongs to the session, and an
    // editor or note window says as much about what is being worked on as a
    // browser tab does. Each rule's own scope decides how far it reaches.
    if (titleRules.length > 0 && s.title) {
      // One holder for the whole loop. Every rule below reads the same
      // normalized title, and a scope-rejected rule never causes it to be
      // computed at all.
      const title = new SessionTitle(s.title);
      let titleBest: Candidate | undefined;
      for (const candidate of titleRules) {
        if (!preparedTitleRuleMatches(candidate.prepared, s, title, browserProcesses)) continue;
        const candidatePriority = effectivePriority(candidate);
        const bestPriority = titleBest ? effectivePriority(titleBest) : Number.POSITIVE_INFINITY;
        if (
          !titleBest ||
          candidatePriority < bestPriority ||
          (candidatePriority === bestPriority &&
            titleScopeSpecificity(candidate.rule.scopeKind) >
              titleScopeSpecificity(titleBest.rule.scopeKind)) ||
          (candidatePriority === bestPriority &&
            candidate.rule.scopeKind === titleBest.rule.scopeKind &&
            titleMatchSpecificity(candidate.rule.titleMatchMode, candidate.rule.titleAnchor) >
              titleMatchSpecificity(titleBest.rule.titleMatchMode, titleBest.rule.titleAnchor)) ||
          (candidatePriority === bestPriority &&
            candidate.rule.scopeKind === titleBest.rule.scopeKind &&
            titleMatchSpecificity(candidate.rule.titleMatchMode, candidate.rule.titleAnchor) ===
              titleMatchSpecificity(titleBest.rule.titleMatchMode, titleBest.rule.titleAnchor) &&
            candidate.rule.pattern.length > titleBest.rule.pattern.length)
        ) {
          titleBest = candidate;
        }
      }
      consider(titleBest);
    }

    if (!best) return { category: null, winningRule: null, source: "none" };
    const winningRule = (best as Candidate).rule;
    return {
      category: catById.get(winningRule.categoryId) ?? null,
      winningRule,
      source: "rule",
    };
  };
}
