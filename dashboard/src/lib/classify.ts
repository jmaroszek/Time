// Rule-based session classification. Priority decides between matching rules
// (seeds: domain 300 > title 200 > process 100). Domain and title rules only
// apply to browser sessions; process rules apply to everything. AFK sessions
// are never classified.

export interface Category {
  id: number;
  name: string;
  color: string;
  isProductive: boolean;
  /** Ignored categories are hidden from every visualization. */
  isIgnored: boolean;
  sortOrder: number | null;
}

export type MatchType = "process" | "domain" | "title";

export interface Rule {
  id: number;
  matchType: MatchType;
  pattern: string;
  categoryId: number;
  priority: number;
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
      if (!best || r.priority > best.priority) best = r;
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
