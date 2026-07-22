// Rule-based session classification. Priority decides between matching rules
// (domain 1 < title 2 < process 3). Lower numbers win. Domain and title rules only
// apply to browser sessions; process rules apply to everything. AFK sessions
// are never classified.

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

export interface Rule {
  id: number;
  matchType: MatchType;
  pattern: string;
  categoryId: number;
  priority: number;
}

/** Normalize a user-entered rule pattern into a matchable one, or null when
 *  nothing matchable remains. Domain patterns accept a pasted URL and reduce
 *  it to the bare host — mirrors tracker/domains.py `_clean_host`, which is
 *  what produces the `domain` values these rules compare against. */
export function normalizeRulePattern(matchType: MatchType, raw: string): string | null {
  let pat = raw.toLowerCase().trim();
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
  type Candidate = { rule: Rule; order: number };
  const processRules = new Map<string, Candidate>();
  const domainRules = new Map<string, Candidate>();
  const titleRules: Candidate[] = [];
  const prefer = (left: Candidate | undefined, right: Candidate): Candidate =>
    !left || right.rule.priority < left.rule.priority ? right : left;
  for (const [order, r] of rules.entries()) {
    const candidate = { rule: { ...r, pattern: r.pattern.toLowerCase() }, order };
    if (r.matchType === "process") {
      processRules.set(candidate.rule.pattern, prefer(processRules.get(candidate.rule.pattern), candidate));
    } else if (r.matchType === "domain") {
      domainRules.set(candidate.rule.pattern, prefer(domainRules.get(candidate.rule.pattern), candidate));
    } else {
      titleRules.push(candidate);
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
      if (candidate && (!best || candidate.rule.priority < best.rule.priority)) best = candidate;
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
              candidate.rule.priority < domainBest.rule.priority ||
              (candidate.rule.priority === domainBest.rule.priority &&
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
      if (titleRules.length > 0) {
        const title = s.title.toLowerCase();
        for (const candidate of titleRules) {
          if (title.includes(candidate.rule.pattern)) consider(candidate);
        }
      }
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
