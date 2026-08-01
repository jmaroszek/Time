// Offering to replace several exact Website rules with one rule for the parent
// they share.
//
// This is not a new matching mechanism. classify.ts already walks a domain's
// suffix chain and prefers the longest matching pattern, so one `google.com`
// rule already covers every subdomain and a surviving exact rule still beats
// it. All this module does is notice when a set of rules has become a pattern
// and check that saying so out loud would be safe.
//
// There is no equivalent for apps: process matching is an exact Map lookup with
// no wildcard in the schema, so there is no rule a set of process rules could
// be consolidated into.
//
// Every gate here fails toward *not* suggesting. A missed consolidation costs
// nothing — the exact rules keep working — while a suggestion that is wrong
// teaches the reader to dismiss the next one without reading it.

import type { ActivitySource } from "./activity";
import { findDuplicateRule } from "./categoryRules";
import { buildClassifier, DEFAULT_RULE_PRIORITY, type Rule } from "./classify";
import { isPublicSuffix } from "./publicSuffix";

/** Two rules sharing a parent is a coincidence. Three is a pattern. */
export const MIN_CHILD_RULES = 3;

/**
 * How much recorded time under the parent makes this worth raising.
 *
 * An hour, matching the floor the Activity tab's backlog mark uses, and for the
 * same reason: below it, a correct suggestion still costs more attention than
 * the row it removes from a list nobody is currently reading.
 */
export const MIN_CONSOLIDATION_SECONDS = 3600;

/**
 * How many candidates get the full session pass before we give up for this
 * render. Candidates are examined best-first, so the cap only ever costs a
 * weaker suggestion than one already rejected — never a missed strong one.
 */
export const MAX_CANDIDATES_EXAMINED = 5;

/** Stands in for the rule being proposed, which has no id until it is written.
 *  Real ids are positive, so this cannot collide. */
const CANDIDATE_RULE_ID = -1;

export interface CandidateParent {
  parent: string;
  categoryId: number;
  childRules: Rule[];
}

export interface ConsolidationSuggestion {
  parent: string;
  categoryId: number;
  /** The rules the parent would replace, kept whole so Undo can rewrite them. */
  childRules: Rule[];
  /** Sites with no rule today that the parent would classify. Named in full by
   *  the UI: this is the only thing the change actually alters. */
  absorbedDomains: string[];
  /** Recorded time under the parent. Only the materiality floor reads it —
   *  ranking happens before any of this is known, on rule count alone. */
  seconds: number;
}

/** Whether `domain` sits at or beneath `parent`. */
function isUnder(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Parents worth examining, best first.
 *
 * Cheap by design — rules only, no sessions — so the expensive safety check
 * runs against an already-ordered shortlist.
 */
export function candidateParents(
  rules: Rule[],
  dismissed: Set<string> = new Set(),
): CandidateParent[] {
  const byParent = new Map<string, Rule[]>();
  for (const rule of rules) {
    if (rule.matchType !== "domain") continue;
    const labels = rule.pattern.toLowerCase().split(".");
    // From 1: a rule is never its own parent, only a proper suffix is.
    for (let i = 1; i < labels.length; i += 1) {
      const parent = labels.slice(i).join(".");
      const group = byParent.get(parent);
      if (group) group.push(rule);
      else byParent.set(parent, [rule]);
    }
  }

  const candidates: CandidateParent[] = [];
  for (const [parent, childRules] of byParent) {
    if (dismissed.has(parent)) continue;
    // The reason the list is vendored. Without it `bbc.co.uk` and
    // `guardian.co.uk` propose `co.uk`, one click from classifying every future
    // UK site. This also subsumes a label-count floor: `com` is a public suffix
    // too, by an explicit rule, and an unknown TLD is one by the implicit `*`.
    if (isPublicSuffix(parent)) continue;
    if (childRules.length < MIN_CHILD_RULES) continue;
    const categoryId = childRules[0].categoryId;
    if (childRules.some((rule) => rule.categoryId !== categoryId)) continue;
    // Deliberately no gate on a child's stored priority. It looks like one is
    // wanted — the parent is written at the default — but the numbers are not
    // reliably the defaults: the scheme is recorded per database in
    // `rule_priority_scheme`, and rules carried through older schemas keep
    // whatever they were migrated with. Gating on it would quietly switch this
    // feature off for those databases. verifyConsolidation is the authority
    // instead: it classifies every session through the real precedence rules
    // before and after, so a priority that changes any outcome is caught there
    // as a behaviour change rather than guessed at here.
    //
    // Nothing to propose if the parent is already written. Uses the same
    // identity SQLite enforces, so a differently-spelled duplicate still counts.
    if (findDuplicateRule(rules, "domain", parent)) continue;
    candidates.push({ parent, categoryId, childRules });
  }

  return candidates.sort(
    (left, right) =>
      right.childRules.length - left.childRules.length
      || left.parent.localeCompare(right.parent),
  );
}

/**
 * Whether replacing a candidate's rules with its parent is safe, and what it
 * would change.
 *
 * The invariant: **no session may move between two named categories.** Checked
 * by classifying every session twice through the real classifier, so rule
 * precedence — including a domain-scoped Window rule, which outranks every
 * Website rule — is honoured rather than reasoned about.
 *
 * Sessions moving from no category to the target are allowed and collected:
 * that is the one change consolidation makes to recorded history, and the UI
 * names every one of them. Anything else returns null.
 *
 * Deliberately not `previewRule` from titleRuleAnalysis: its `reclassified`
 * counts sessions that had *any* category before, which here is every session
 * under the parent. It cannot tell "moved to a different category" from "same
 * category by a shorter route", and that distinction is the whole check.
 */
export function verifyConsolidation(
  source: ActivitySource,
  candidate: CandidateParent,
): ConsolidationSuggestion | null {
  const browsers = new Set(source.browserProcesses.map((process) => process.toLowerCase()));
  const childIds = new Set(candidate.childRules.map((rule) => rule.id));
  const parentRule: Rule = {
    id: CANDIDATE_RULE_ID,
    matchType: "domain",
    pattern: candidate.parent,
    categoryId: candidate.categoryId,
    priority: DEFAULT_RULE_PRIORITY.domain,
  };
  const before = buildClassifier(source.categories, source.rules, browsers);
  const after = buildClassifier(
    source.categories,
    [...source.rules.filter((rule) => !childIds.has(rule.id)), parentRule],
    browsers,
  );

  const absorbedDomains = new Set<string>();
  let seconds = 0;
  for (const session of source.sessions) {
    if (session.isAfk || session.end <= session.start) continue;
    const domain = session.domain?.toLowerCase() ?? null;
    if (domain && isUnder(domain, candidate.parent)) seconds += session.end - session.start;

    const wasId = before(session)?.id ?? null;
    const willBeId = after(session)?.id ?? null;
    if (wasId === willBeId) continue;
    if (wasId === null && domain) {
      absorbedDomains.add(domain);
      continue;
    }
    return null;
  }

  if (seconds < MIN_CONSOLIDATION_SECONDS) return null;
  // More unruled sites pulled in than rules that produced the parent means the
  // parent is broader than anything the reader has actually decided.
  if (absorbedDomains.size > candidate.childRules.length) return null;

  return {
    parent: candidate.parent,
    categoryId: candidate.categoryId,
    childRules: candidate.childRules,
    absorbedDomains: [...absorbedDomains].sort(),
    seconds,
  };
}

/** The one suggestion worth showing, or none. Examines candidates best-first
 *  and stops at the first that survives every gate. */
export function findConsolidation(
  source: ActivitySource,
  dismissed: Set<string> = new Set(),
): ConsolidationSuggestion | null {
  const candidates = candidateParents(source.rules, dismissed);
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_EXAMINED)) {
    const suggestion = verifyConsolidation(source, candidate);
    if (suggestion) return suggestion;
  }
  return null;
}

/** Parents the reader has turned down, from the setting that stores them. A
 *  corrupt value means "none dismissed" rather than a broken tab. */
export function parseDismissed(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export function serializeDismissed(dismissed: Iterable<string>): string {
  return JSON.stringify([...new Set(dismissed)].sort());
}
