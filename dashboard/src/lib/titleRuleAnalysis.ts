import type { ActivitySource } from "./activity";
import { entityIdentity } from "./entityIdentity";
import { dayKeyFromSeconds } from "./time";
import {
  buildClassifier,
  DEFAULT_RULE_PRIORITY,
  normalizeRulePattern,
  type MatchType,
  type Rule,
} from "./classify";
import {
  containsVersion,
  normalizeTitleRuleSpec,
  normalizeWindowTitle,
  splitWindowTitle,
  titlePatternMatches,
  titleScopeAdmits,
  titleTokens,
  type TitleRuleAnchor,
  type TitleRuleMatchMode,
  type TitleRuleSpec,
} from "./titleRules";

export interface TitleRuleCandidate extends TitleRuleSpec {
  id: string;
  sessions: number;
  seconds: number;
  days: number;
  titles: number;
  entities: number;
  /** Share of distinct, titled windows inside the proposed scope. */
  reach: number;
  recommended: boolean;
}

export interface TitleRulePreview {
  sessions: number;
  seconds: number;
  days: number;
  titles: number;
  entities: number;
  /** Sessions pulled away from a category that classifies them today. */
  reclassified: number;
}

interface TitleAggregate {
  rawTitle: string;
  sessions: number;
  seconds: number;
  days: Set<string>;
  entities: Set<string>;
}

interface DraftCandidate extends TitleRuleSpec {
  position: number;
}

function candidateId(candidate: TitleRuleSpec): string {
  return [
    candidate.pattern,
    candidate.scopeKind,
    candidate.scopeValue,
    candidate.titleMatchMode,
    candidate.titleAnchor,
  ].join("\u0000");
}

function candidateFamily(candidate: TitleRuleSpec): string {
  return `${candidate.pattern}\u0000${candidate.titleMatchMode}`;
}

function anchorFor(index: number, count: number): TitleRuleAnchor {
  if (index === 0) return "first";
  if (index === count - 1) return "last";
  return "interior";
}

function usablePattern(pattern: string, equivalents: Set<string>): boolean {
  const normalized = normalizeWindowTitle(pattern);
  if (normalized.length < 3 || containsVersion(normalized)) return false;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
  return !equivalents.has(normalized);
}

/**
 * Rank a small, diverse set of rules derived from the window in front.
 *
 * Candidates are evaluated against all history inside the proposed scope.
 * Repetition across days and distinct titles is stronger evidence than raw
 * visit count, which prevents one tab-switching-heavy afternoon from looking
 * like a durable identity. App-equivalent or >85%-reach candidates are omitted:
 * those should be App/Website rules, not Window rules in disguise.
 */
export function suggestTitleRuleCandidates(
  source: ActivitySource,
  currentTitle: string,
  scope: Pick<TitleRuleSpec, "scopeKind" | "scopeValue">,
  equivalentNames: string[] = [],
): TitleRuleCandidate[] {
  const normalizedScope = normalizeTitleRuleSpec({
    pattern: "candidate",
    ...scope,
    titleMatchMode: "phrase",
    titleAnchor: "any",
  });
  const browserProcesses = new Set(
    source.browserProcesses.map((process) => process.toLowerCase()),
  );
  const equivalents = new Set(
    equivalentNames
      .flatMap((name) => {
        const normalized = normalizeWindowTitle(name);
        return normalized.endsWith(".exe")
          ? [normalized, normalized.slice(0, -4)]
          : [normalized];
      })
      .filter(Boolean),
  );
  if (normalizedScope.scopeKind === "process") {
    equivalents.add(normalizedScope.scopeValue);
    equivalents.add(normalizedScope.scopeValue.replace(/\.exe$/u, ""));
  } else if (normalizedScope.scopeKind === "domain") {
    equivalents.add(normalizedScope.scopeValue);
    equivalents.add(normalizedScope.scopeValue.replace(/^www\./u, ""));
  }

  const titles = new Map<string, TitleAggregate>();
  for (const session of source.sessions) {
    if (session.isAfk || !session.title || session.end <= session.start) continue;
    if (!titleScopeAdmits(normalizedScope, session, browserProcesses)) continue;
    const normalized = normalizeWindowTitle(session.title);
    if (!normalized) continue;
    let aggregate = titles.get(normalized);
    if (!aggregate) {
      aggregate = {
        rawTitle: session.title,
        sessions: 0,
        seconds: 0,
        days: new Set<string>(),
        entities: new Set<string>(),
      };
      titles.set(normalized, aggregate);
    }
    aggregate.sessions += 1;
    aggregate.seconds += session.end - session.start;
    aggregate.days.add(dayKeyFromSeconds(session.start));
    aggregate.entities.add(entityIdentity(session, browserProcesses).id);
  }
  if (titles.size === 0) return [];

  const segments = splitWindowTitle(currentTitle);
  const drafts = new Map<string, DraftCandidate>();
  const add = (
    pattern: string,
    titleMatchMode: TitleRuleMatchMode,
    titleAnchor: TitleRuleAnchor,
    position: number,
  ) => {
    if (!usablePattern(pattern, equivalents)) return;
    const candidate = normalizeTitleRuleSpec({
      pattern,
      scopeKind: normalizedScope.scopeKind,
      scopeValue: normalizedScope.scopeValue,
      titleMatchMode,
      titleAnchor,
    });
    const id = candidateId(candidate);
    if (!drafts.has(id)) drafts.set(id, { ...candidate, position });
  };

  segments.forEach((segment, index) => {
    const position = segments.length <= 1 ? 0 : index / (segments.length - 1);
    add(segment, "segment", "any", position);
    if (segments.length > 1) add(segment, "segment", anchorFor(index, segments.length), position);
    // Tokenizing destroys the dots that made a version recognizable, so stop
    // before deriving apparently durable phrases from "Obsidian 1.12.4".
    if (containsVersion(segment)) return;

    const tokens = titleTokens(segment);
    if (tokens.length === 1) {
      if (tokens[0].length >= 4) add(tokens[0], "phrase", "any", position);
      return;
    }
    for (let start = 0; start < tokens.length; start += 1) {
      for (
        let length = Math.min(5, tokens.length - start);
        length >= 2;
        length -= 1
      ) {
        add(tokens.slice(start, start + length).join(" "), "phrase", "any", position);
      }
    }
  });

  const evaluated: Array<TitleRuleCandidate & { score: number; position: number }> = [];
  for (const draft of drafts.values()) {
    let sessions = 0;
    let seconds = 0;
    let matchedTitles = 0;
    const days = new Set<string>();
    const entities = new Set<string>();
    for (const aggregate of titles.values()) {
      if (!titlePatternMatches(draft, aggregate.rawTitle)) continue;
      matchedTitles += 1;
      sessions += aggregate.sessions;
      seconds += aggregate.seconds;
      aggregate.days.forEach((day) => days.add(day));
      aggregate.entities.forEach((entity) => entities.add(entity));
    }
    if (matchedTitles === 0) continue;
    const reach = matchedTitles / titles.size;
    // With multiple distinct windows, a rule reaching nearly all of them is an
    // App/Website default wearing a Window label. One-window scopes keep a
    // precise fallback because there is no generalization evidence yet.
    if (titles.size >= 3 && reach > 0.85) continue;
    const recurring = days.size >= 2 || matchedTitles >= 2;
    const precision = draft.titleMatchMode === "segment"
      ? (draft.titleAnchor === "any" ? 12 : 18)
      : draft.titleMatchMode === "phrase"
        ? 8
        : 0;
    const score =
      (recurring ? 1_000 : 0) +
      days.size * 80 +
      matchedTitles * 18 +
      Math.log1p(seconds) * 6 +
      draft.position * 8 +
      precision;
    evaluated.push({
      ...draft,
      id: candidateId(draft),
      sessions,
      seconds,
      days: days.size,
      titles: matchedTitles,
      entities: entities.size,
      reach,
      recommended: false,
      score,
    });
  }

  evaluated.sort(
    (left, right) =>
      right.score - left.score ||
      right.days - left.days ||
      right.seconds - left.seconds ||
      right.position - left.position ||
      right.pattern.length - left.pattern.length,
  );
  // One best candidate per pattern/mode family avoids four visually identical
  // chips that differ only by an anchor with no material benefit.
  const families = new Set<string>();
  const selected: TitleRuleCandidate[] = [];
  for (const candidate of evaluated) {
    const family = candidateFamily(candidate);
    if (families.has(family)) continue;
    families.add(family);
    const { score: _score, position: _position, ...visible } = candidate;
    selected.push({ ...visible, recommended: selected.length === 0 });
    if (selected.length === 4) break;
  }
  return selected;
}

/**
 * Preview a rule of any kind through the real classifier, including precedence.
 *
 * A session counts only when the candidate is the rule that *wins* it, not
 * merely one that matches: a pattern already outranked everywhere claims
 * nothing, and saying otherwise would promise a change that never arrives.
 *
 * Null when the pattern normalizes to nothing matchable — `addRule` rejects the
 * same input, so the preview can say so before the button is pressed.
 * `replaceRuleId` keeps the before-state intact while removing that rule from
 * the proposed after-state, which is what makes an inline edit a replacement
 * rather than a second rule competing with the one still being edited.
 */
export function previewRule(
  source: ActivitySource,
  matchType: MatchType,
  rawPattern: string,
  rawSpec: Partial<Omit<TitleRuleSpec, "pattern">> = {},
  replaceRuleId?: number,
): TitleRulePreview | null {
  const pattern = normalizeRulePattern(matchType, rawPattern);
  if (!pattern) return null;
  const browsers = new Set(
    source.browserProcesses.map((process) => process.toLowerCase()),
  );
  const spec = normalizeTitleRuleSpec({
    pattern,
    scopeKind: rawSpec.scopeKind ?? "any",
    scopeValue: rawSpec.scopeValue ?? "",
    titleMatchMode: rawSpec.titleMatchMode ?? "phrase",
    titleAnchor: rawSpec.titleAnchor ?? "any",
  });
  const before = buildClassifier(source.categories, source.rules, browsers);
  const candidate: Rule = matchType === "title"
    ? { id: -1, matchType, categoryId: -1, priority: DEFAULT_RULE_PRIORITY.title, ...spec }
    : { id: -1, matchType, pattern, categoryId: -1, priority: DEFAULT_RULE_PRIORITY[matchType] };
  const after = buildClassifier(
    [
      ...source.categories,
      {
        id: -1,
        name: "",
        color: "#000",
        isProductive: false,
        isNeutral: true,
        isIgnored: false,
        sortOrder: null,
      },
    ],
    [
      ...source.rules.filter((rule) => rule.id !== replaceRuleId),
      candidate,
    ],
    browsers,
  );
  let sessions = 0;
  let seconds = 0;
  let reclassified = 0;
  const days = new Set<string>();
  const titles = new Set<string>();
  const entities = new Set<string>();
  for (const session of source.sessions) {
    if (session.isAfk || session.end <= session.start) continue;
    if (after(session)?.id !== -1) continue;
    sessions += 1;
    seconds += session.end - session.start;
    days.add(dayKeyFromSeconds(session.start));
    // App and Website rules claim untitled sessions too, so the title count is
    // a property of what matched rather than of every counted session.
    if (session.title) titles.add(normalizeWindowTitle(session.title));
    entities.add(entityIdentity(session, browsers).id);
    if (before(session) !== null) reclassified += 1;
  }
  return {
    sessions,
    seconds,
    days: days.size,
    titles: titles.size,
    entities: entities.size,
    reclassified,
  };
}

/** A Window rule always has a pattern once normalized, so the dialog's caller
 *  never has to consider the null case. */
export function previewTitleRule(
  source: ActivitySource,
  rawSpec: TitleRuleSpec,
): TitleRulePreview {
  return (
    previewRule(source, "title", rawSpec.pattern, rawSpec)
    ?? { sessions: 0, seconds: 0, days: 0, titles: 0, entities: 0, reclassified: 0 }
  );
}
