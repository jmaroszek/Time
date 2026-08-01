// Public Suffix List matching.
//
// Answers one question for rule consolidation: is this domain something a
// person can register under, or is it the boundary itself? `bbc.co.uk` is
// registrable; `co.uk` is not, and offering it as a rule pattern would put
// every future UK site into one category.
//
// The rules are vendored — see publicSuffixData.ts and the script named in its
// header.

import { PUBLIC_SUFFIX_RULES } from "./publicSuffixData";

interface RuleSets {
  /** Rules as written, including wildcard forms like `*.ck`. */
  normal: Set<string>;
  /** Exception rules with the leading `!` removed, so they can be looked up
   *  against a domain suffix directly. */
  exceptions: Set<string>;
}

// Ten thousand rules parse in a few milliseconds, but the consolidation check
// asks this question once per candidate parent per render. Built on first use
// rather than at module load, so a session that never opens Categories & Rules
// never pays for it at all.
let cached: RuleSets | null = null;

function ruleSets(): RuleSets {
  if (cached) return cached;
  const normal = new Set<string>();
  const exceptions = new Set<string>();
  for (const line of PUBLIC_SUFFIX_RULES.split("\n")) {
    const rule = line.trim();
    if (!rule) continue;
    if (rule.startsWith("!")) exceptions.add(rule.slice(1));
    else normal.add(rule);
  }
  cached = { normal, exceptions };
  return cached;
}

/** Lowercased, with the root dot and any stray leading dots removed. Domains
 *  reach us from window titles by way of the tracker, so they are already
 *  cleaned — this is the belt to that braces. */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^\.+|\.+$/g, "");
}

/**
 * The public suffix of a domain, per the algorithm the list is published with.
 *
 * A rule matches when its labels equal the domain's trailing labels, with `*`
 * matching any single label. An exception rule wins over every other match and
 * yields itself minus its leftmost label; otherwise the match with the most
 * labels wins. A domain matching no rule at all takes the implicit `*` rule,
 * which makes its rightmost label the public suffix — so an unknown or new TLD
 * still behaves like a boundary rather than like a registrable name.
 *
 * Returns "" for an empty input, which `isPublicSuffix` reports as false.
 */
export function publicSuffixOf(domain: string): string {
  const normalized = normalizeDomain(domain);
  if (!normalized) return "";
  const { normal, exceptions } = ruleSets();
  const labels = normalized.split(".");

  // Longest suffix first, so the first hit in either loop is already the match
  // with the most labels and no comparison is needed.
  for (let i = 0; i < labels.length; i += 1) {
    if (exceptions.has(labels.slice(i).join("."))) {
      return labels.slice(i + 1).join(".");
    }
  }
  for (let i = 0; i < labels.length; i += 1) {
    const suffix = labels.slice(i).join(".");
    if (normal.has(suffix)) return suffix;
    // The wildcard form of the same suffix: `*.ck` is what matches `foo.ck`.
    // Only meaningful while a label remains to the right of the star.
    if (i < labels.length - 1 && normal.has(`*.${labels.slice(i + 1).join(".")}`)) {
      return suffix;
    }
  }
  return labels[labels.length - 1];
}

/**
 * Whether a domain is a public suffix rather than a registrable name.
 *
 * This is the whole reason the list is vendored. It also subsumes a label
 * count check: every single-label name is a public suffix, either by an
 * explicit rule or by the implicit `*`.
 */
export function isPublicSuffix(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return publicSuffixOf(normalized) === normalized;
}
