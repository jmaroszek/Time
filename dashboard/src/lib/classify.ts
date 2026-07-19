// Rule-based session classification. Priority decides between matching rules
// (seeds: domain 1 < title 2 < process 3). Lower numbers win. Domain and title rules only
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
}

export type Classifier = (s: Classifiable) => Category | null;

export function buildClassifier(
  categories: Category[],
  rules: Rule[],
  browserProcesses: Set<string>,
): Classifier {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const processRules: Rule[] = [];
  const domainRules: Rule[] = [];
  const titleRules: Rule[] = [];
  for (const r of rules) {
    const normalized = { ...r, pattern: r.pattern.toLowerCase() };
    if (r.matchType === "process") processRules.push(normalized);
    else if (r.matchType === "domain") domainRules.push(normalized);
    else titleRules.push(normalized);
  }

  return (s: Classifiable): Category | null => {
    if (s.isAfk) return null;
    let best: Rule | null = null;
    const consider = (r: Rule) => {
      if (!best || r.priority < best.priority) best = r;
    };

    const proc = s.process.toLowerCase();
    for (const r of processRules) if (r.pattern === proc) consider(r);

    if (browserProcesses.has(proc)) {
      const domain = s.domain?.toLowerCase() ?? null;
      if (domain) {
        for (const r of domainRules) {
          if (domain === r.pattern || domain.endsWith("." + r.pattern)) consider(r);
        }
      }
      const title = s.title.toLowerCase();
      for (const r of titleRules) if (title.includes(r.pattern)) consider(r);
    }

    return best ? (catById.get((best as Rule).categoryId) ?? null) : null;
  };
}
