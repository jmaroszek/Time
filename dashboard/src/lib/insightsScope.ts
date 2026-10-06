import type { Category, Classifier } from "./classify";
import { entityIdentity, insightsMember, windowGroupKey } from "./entityIdentity";
import { appGroupKey, cleanDomainName, cleanProcessName } from "./format";
import { forEachDayChunk, type Session } from "./metrics";
import {
  collectRuns,
  orderedByStart,
  runNeighbors,
  runStats,
  type RunRowKind,
  type RunSpan,
} from "./runs";
import { normalizeWindowTitle } from "./titleRules";
import { dayKey } from "./time";

/** The category an app or website was opened from, which it then stays inside. */
export interface ScopeParent {
  categoryId: number;
  name: string;
}

/**
 * One app, website, or category Insights can be narrowed to.
 *
 * Apps are identified the way Insights' own rows identify them — by
 * `appGroupKey` — not the way Activity does. An alias merges processes into one
 * row, and the scope follows the row, so opening a row shows the total that row
 * showed. A browser's app scope therefore includes its website time, exactly as
 * its Top Apps row does. `name` is the label at the moment of selection.
 *
 * An app or website opened from a category's own list keeps to that category
 * (`within`): Chrome opened from Entertainment is the Chrome time that was
 * Entertainment, not all of Chrome. Every row in that list was measured that
 * way, so a click that widened to the whole app would land on a different
 * number than the one clicked.
 */
export type InsightsScope =
  | { kind: "app"; key: string; name: string; within?: ScopeParent }
  | { kind: "website"; key: string; name: string; within?: ScopeParent }
  | { kind: "category"; categoryId: number; name: string };

export interface ScopeContext {
  classifier: Classifier;
  aliases: Record<string, string>;
  /** Lowercased, as the meta browser set already is. */
  browserProcesses: ReadonlySet<string>;
}

/** Stable identity for comparing two scopes. */
export function scopeKey(scope: InsightsScope): string {
  if (scope.kind === "category") return `category:${scope.categoryId}`;
  return `${scope.kind}:${scope.key}${scope.within ? `@${scope.within.categoryId}` : ""}`;
}

/** The category an app or website is held inside, as a scope of its own. */
export function parentScope(scope: InsightsScope): InsightsScope | null {
  return scope.kind !== "category" && scope.within
    ? { kind: "category", categoryId: scope.within.categoryId, name: scope.within.name }
    : null;
}

/** Whether a session belongs to the scope. AFK rows never do: they carry no
 *  identity to belong by. */
export function scopeMatcher(
  scope: InsightsScope,
  context: ScopeContext,
): (session: Session) => boolean {
  switch (scope.kind) {
    case "category":
      return (session) =>
        !session.isAfk && context.classifier(session)?.id === scope.categoryId;
    case "app": {
      const within = scope.within?.categoryId;
      return (session) =>
        !session.isAfk
        && appGroupKey(session.process, context.aliases) === scope.key
        && (within === undefined || context.classifier(session)?.id === within);
    }
    case "website": {
      const within = scope.within?.categoryId;
      return (session) =>
        !session.isAfk
        && session.domain !== null
        && context.browserProcesses.has(session.process.toLowerCase())
        && session.domain.toLowerCase() === scope.key
        && (within === undefined || context.classifier(session)?.id === within);
    }
  }
}

/**
 * What each session is to a scope's runs. Ignored activity is treated as
 * unrecorded, as it is everywhere else in Insights — including when it would
 * otherwise belong to the scope, since none of the scope's totals count it.
 */
export function scopeRowKind(
  inScope: (session: Session) => boolean,
  classifier: Classifier,
): (session: Session) => RunRowKind {
  return (session) => {
    if (session.isAfk) return "idle";
    if (classifier(session)?.isIgnored) return "unrecorded";
    return inScope(session) ? "in" : "other";
  };
}

/** The scope's runs within [startSec, endSec). See lib/runs for what a run is.
 *  A category's runs continue across its own members: two of its apps back to
 *  back are one run. */
export function scopeRuns(
  sessions: readonly Session[],
  inScope: (session: Session) => boolean,
  classifier: Classifier,
  startSec: number,
  endSec: number,
): RunSpan[] {
  return collectRuns(
    orderedByStart(sessions),
    scopeRowKind(inScope, classifier),
    startSec,
    endSec,
  );
}

export interface ScopeWindowSpan {
  startSec: number;
  endSec: number;
}

export interface ScopeSummary {
  /** Time in the scope within the range. */
  seconds: number;
  /** Everything counted in the range, for the scope's share of it. */
  trackedSeconds: number;
  /** The parent category's time in the range, for an app or website held
   *  inside one — its share is of that, not of everything. */
  parentSeconds: number | null;
  /** Time in the scope over the comparison period; null when there is none. */
  previousSeconds: number | null;
  daysUsed: number;
  runs: number;
  /** Half of the scope's time came in runs at least this long. Null when
   *  nothing was recorded. */
  typicalRunSeconds: number | null;
  longestRunSeconds: number | null;
  /** What most of the scope's time resolved to; null when that was
   *  uncategorized time. A category scope is, trivially, itself. */
  category: Category | null;
}

/** The headline figures for one scope across a range. */
export function summarizeScope(
  sessions: readonly Session[],
  inScope: (session: Session) => boolean,
  classifier: Classifier,
  range: ScopeWindowSpan,
  previous: ScopeWindowSpan | null,
  inParent: ((session: Session) => boolean) | null = null,
): ScopeSummary {
  const stats = runStats(scopeRuns(sessions, inScope, classifier, range.startSec, range.endSec));
  let trackedSeconds = 0;
  let parentSeconds = inParent ? 0 : null;
  let previousSeconds = previous ? 0 : null;
  const days = new Set<string>();
  const categorySeconds = new Map<Category | null, number>();
  for (const session of sessions) {
    if (session.isAfk) continue;
    const category = classifier(session);
    if (category?.isIgnored) continue;
    const start = Math.max(session.start, range.startSec);
    const end = Math.min(session.end, range.endSec);
    const matches = inScope(session);
    if (end > start) {
      trackedSeconds += end - start;
      if (parentSeconds !== null && inParent?.(session)) parentSeconds += end - start;
      if (matches) {
        forEachDayChunk(start, end, (chunk) => days.add(dayKey(chunk.dayStart)));
        categorySeconds.set(category, (categorySeconds.get(category) ?? 0) + end - start);
      }
    }
    if (previous && previousSeconds !== null && matches) {
      const previousStart = Math.max(session.start, previous.startSec);
      const previousEnd = Math.min(session.end, previous.endSec);
      if (previousEnd > previousStart) previousSeconds += previousEnd - previousStart;
    }
  }
  let category: Category | null = null;
  let heaviest = 0;
  for (const [candidate, seconds] of categorySeconds) {
    if (seconds > heaviest) {
      heaviest = seconds;
      category = candidate;
    }
  }
  return {
    seconds: stats.seconds,
    trackedSeconds,
    parentSeconds,
    previousSeconds,
    daysUsed: days.size,
    runs: stats.runs,
    typicalRunSeconds: stats.typicalSeconds,
    longestRunSeconds: stats.longestSeconds,
    category,
  };
}

export interface ScopeWindow {
  /** The normalized title, which is what groups the rows. */
  key: string;
  /** The newest original spelling among the grouped sessions. */
  title: string;
  seconds: number;
  /** Activity's entity for the window — the one most of its time was in, for
   *  a title more than one of an alias's processes showed. */
  entityId: string;
  /** Activity's key for the same window, so it can be opened there. */
  activityKey: string;
}

export interface ScopeWindowList {
  rows: ScopeWindow[];
  /** Distinct titled windows, of which `rows` is the heaviest. */
  total: number;
  /** Time in the scope recorded without a title. */
  untitledSeconds: number;
}

/** The scope's heaviest windows across a range, grouped the way Activity groups
 *  them so the two never disagree about what counts as one window. */
export function topScopeWindows(
  sessions: readonly Session[],
  inScope: (session: Session) => boolean,
  context: ScopeContext,
  range: ScopeWindowSpan,
  limit: number,
): ScopeWindowList {
  const windows = new Map<string, {
    key: string;
    title: string;
    seconds: number;
    newest: number;
    entities: Map<string, number>;
  }>();
  let untitledSeconds = 0;
  for (const session of sessions) {
    if (!inScope(session) || context.classifier(session)?.isIgnored) continue;
    const start = Math.max(session.start, range.startSec);
    const end = Math.min(session.end, range.endSec);
    if (end <= start) continue;
    const key = session.title ? normalizeWindowTitle(session.title) : "";
    if (!key) {
      untitledSeconds += end - start;
      continue;
    }
    let row = windows.get(key);
    if (!row) {
      row = { key, title: session.title, seconds: 0, newest: session.start, entities: new Map() };
      windows.set(key, row);
    }
    row.seconds += end - start;
    if (session.start >= row.newest) {
      row.newest = session.start;
      row.title = session.title;
    }
    const entity = entityIdentity(session, context.browserProcesses).id;
    row.entities.set(entity, (row.entities.get(entity) ?? 0) + end - start);
  }
  const rows = [...windows.values()]
    .sort((left, right) => right.seconds - left.seconds || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map(({ key, title, seconds, entities }) => {
      let entityId = "";
      let most = -1;
      for (const [candidate, entitySeconds] of entities) {
        if (entitySeconds > most || (entitySeconds === most && candidate < entityId)) {
          most = entitySeconds;
          entityId = candidate;
        }
      }
      return { key, title, seconds, entityId, activityKey: windowGroupKey(entityId, key) };
    });
  return { rows, total: windows.size, untitledSeconds };
}

/** One place a run came from or went to, and how many runs did. */
export interface ScopeNeighbor {
  /** An `insightsMember` key, or "break". */
  key: string;
  name: string;
  kind: "app" | "website" | "break";
  /** What most of the neighbor's transition time was classified as. */
  category: Category | null;
  runs: number;
}

export interface ScopeTransitions {
  /** Most common first. The break — idle, or nothing recorded — is a row like
   *  any other, because "after a break" is a real and common answer. */
  before: ScopeNeighbor[];
  after: ScopeNeighbor[];
  /** Runs whose side was known: the share denominators. Runs cut off by the
   *  start of history or still going at the live edge are left out. */
  beforeRuns: number;
  afterRuns: number;
}

export const BREAK_NEIGHBOR_NAME = "Idle or away";

/**
 * What the reader was doing right before each run of the scope, and what they
 * went to right after.
 *
 * Neighbors are named the way the breakdown in the Hours card names members —
 * the website for browser time that recorded one, otherwise the app — so
 * "YouTube" leads to a run, not "Google Chrome".
 */
export function scopeTransitions(
  sessions: readonly Session[],
  inScope: (session: Session) => boolean,
  context: ScopeContext,
  range: ScopeWindowSpan,
): ScopeTransitions {
  const rows = orderedByStart(sessions);
  const kindOf = scopeRowKind(inScope, context.classifier);
  const runs = collectRuns(rows, kindOf, range.startSec, range.endSec);
  type Tally = Omit<ScopeNeighbor, "category"> & { categories: Map<Category | null, number> };
  const tally = (into: Map<string, Tally>, neighbor: Session | "break" | null): boolean => {
    if (neighbor === null) return false;
    if (neighbor === "break") {
      const entry = into.get("break") ?? {
        key: "break",
        name: BREAK_NEIGHBOR_NAME,
        kind: "break" as const,
        runs: 0,
        categories: new Map(),
      };
      entry.runs += 1;
      into.set("break", entry);
      return true;
    }
    const member = insightsMember(neighbor, context.aliases, context.browserProcesses);
    const entry = into.get(member.key) ?? {
      key: member.key,
      name: member.name,
      kind: member.kind,
      runs: 0,
      categories: new Map(),
    };
    entry.runs += 1;
    const category = context.classifier(neighbor);
    entry.categories.set(category, (entry.categories.get(category) ?? 0) + 1);
    into.set(member.key, entry);
    return true;
  };
  const before = new Map<string, Tally>();
  const after = new Map<string, Tally>();
  let beforeRuns = 0;
  let afterRuns = 0;
  for (const run of runs) {
    const neighbors = runNeighbors(rows, kindOf, run);
    if (tally(before, neighbors.before)) beforeRuns += 1;
    if (tally(after, neighbors.after)) afterRuns += 1;
  }
  const ranked = (from: Map<string, Tally>): ScopeNeighbor[] =>
    [...from.values()]
      .map(({ categories, ...entry }) => {
        let category: Category | null = null;
        let most = 0;
        for (const [candidate, count] of categories) {
          if (count > most) {
            most = count;
            category = candidate;
          }
        }
        return { ...entry, category };
      })
      .sort((left, right) => right.runs - left.runs || left.name.localeCompare(right.name));
  return { before: ranked(before), after: ranked(after), beforeRuns, afterRuns };
}

/** Something the scope picker can offer, with the time it holds in range. */
export interface ScopeCandidate {
  scope: InsightsScope;
  seconds: number;
  /** The category the candidate's time mostly resolved to — itself, for a
   *  category. Null when that was uncategorized time. */
  category: Category | null;
}

export interface ScopeCandidates {
  categories: ScopeCandidate[];
  apps: ScopeCandidate[];
  websites: ScopeCandidate[];
}

/**
 * Every category, app, and website with time in the range, heaviest first —
 * what the scope picker searches. Identified exactly as the ranked lists
 * identify them, so picking a name here and clicking it there open the same
 * scope.
 */
export function scopeCandidates(
  sessions: readonly Session[],
  context: ScopeContext,
  range: ScopeWindowSpan,
): ScopeCandidates {
  type Entry = { scope: InsightsScope; seconds: number; categories: Map<Category | null, number> };
  const categories = new Map<string, Entry>();
  const apps = new Map<string, Entry>();
  const websites = new Map<string, Entry>();
  const add = (
    into: Map<string, Entry>,
    key: string,
    make: () => InsightsScope,
    category: Category | null,
    seconds: number,
  ) => {
    let entry = into.get(key);
    if (!entry) {
      entry = { scope: make(), seconds: 0, categories: new Map() };
      into.set(key, entry);
    }
    entry.seconds += seconds;
    entry.categories.set(category, (entry.categories.get(category) ?? 0) + seconds);
  };
  for (const session of sessions) {
    if (session.isAfk) continue;
    const start = Math.max(session.start, range.startSec);
    const end = Math.min(session.end, range.endSec);
    if (end <= start) continue;
    const category = context.classifier(session);
    if (category?.isIgnored) continue;
    const seconds = end - start;
    if (category) {
      add(categories, String(category.id), () => ({
        kind: "category",
        categoryId: category.id,
        name: category.name,
      }), category, seconds);
    }
    const app = appGroupKey(session.process, context.aliases);
    add(apps, app, () => ({
      kind: "app",
      key: app,
      name: cleanProcessName(session.process, context.aliases),
    }), category, seconds);
    if (session.domain && context.browserProcesses.has(session.process.toLowerCase())) {
      const domain = session.domain.toLowerCase();
      add(websites, domain, () => ({
        kind: "website",
        key: domain,
        name: cleanDomainName(domain, context.aliases),
      }), category, seconds);
    }
  }
  const ranked = (from: Map<string, Entry>): ScopeCandidate[] =>
    [...from.values()]
      .map(({ scope, seconds, categories: split }) => {
        let category: Category | null = null;
        let most = 0;
        for (const [candidate, candidateSeconds] of split) {
          if (candidateSeconds > most) {
            most = candidateSeconds;
            category = candidate;
          }
        }
        return { scope, seconds, category };
      })
      .sort((left, right) => right.seconds - left.seconds || left.scope.name.localeCompare(right.scope.name));
  return {
    categories: ranked(categories),
    apps: ranked(apps),
    websites: ranked(websites),
  };
}

/**
 * The candidates whose name — or, for a website, whose host — contains the
 * query, each section still heaviest first and cut to `limits`. An empty query
 * browses: the same cut, applied to everything.
 */
export function searchScopeCandidates(
  candidates: ScopeCandidates,
  query: string,
  limits: { categories: number; apps: number; websites: number },
): ScopeCandidates {
  const needle = query.trim().toLowerCase();
  const matches = (candidate: ScopeCandidate) =>
    candidate.scope.name.toLowerCase().includes(needle)
    || (candidate.scope.kind === "website" && candidate.scope.key.includes(needle));
  const pick = (list: ScopeCandidate[], limit: number) =>
    (needle ? list.filter(matches) : list).slice(0, limit);
  return {
    categories: pick(candidates.categories, limits.categories),
    apps: pick(candidates.apps, limits.apps),
    websites: pick(candidates.websites, limits.websites),
  };
}
