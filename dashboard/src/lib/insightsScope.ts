import {
  categoryState,
  type Category,
  type Classifier,
} from "./classify";
import { entityIdentity, windowGroupKey } from "./entityIdentity";
import { appGroupKey, cleanDomainName, cleanProcessName } from "./format";
import { forEachDayChunk, type Session } from "./metrics";
import {
  collectRuns,
  orderedByStart,
  runStats,
  type RunRowKind,
  type RunSpan,
} from "./runs";
import { windowGroupTitle } from "./activityFormat";
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
  /** The app group and grouped title, which is what groups the rows. */
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
    groupTitle: string;
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
    const entity = entityIdentity(session, context.browserProcesses);
    const title = session.title ? windowGroupTitle(session.title, session.process, entity.key) : "";
    if (!title) {
      untitledSeconds += end - start;
      continue;
    }
    // By app as well: with the app's suffix gone, "Inbox" in a mail client and
    // "Inbox" in a browser would otherwise be one window. An alias's processes
    // share an app group, so they still meet in one row.
    const key = `${appGroupKey(session.process, context.aliases)}\u0000${title}`;
    let row = windows.get(key);
    if (!row) {
      row = { key, groupTitle: title, title: session.title, seconds: 0, newest: session.start, entities: new Map() };
      windows.set(key, row);
    }
    row.seconds += end - start;
    if (session.start >= row.newest) {
      row.newest = session.start;
      row.title = session.title;
    }
    row.entities.set(entity.id, (row.entities.get(entity.id) ?? 0) + end - start);
  }
  const rows = [...windows.values()]
    .sort((left, right) => right.seconds - left.seconds || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map(({ key, groupTitle, title, seconds, entities }) => {
      let entityId = "";
      let most = -1;
      for (const [candidate, entitySeconds] of entities) {
        if (entitySeconds > most || (entitySeconds === most && candidate < entityId)) {
          most = entitySeconds;
          entityId = candidate;
        }
      }
      return { key, title, seconds, entityId, activityKey: windowGroupKey(entityId, groupTitle) };
    });
  return { rows, total: windows.size, untitledSeconds };
}

const KIND_WORDS = { app: "app", website: "website", category: "category" } as const;

/**
 * The words after a subject's name in the header, written to finish the name
 * as a phrase: "Obsidian notes app", "AI productive category".
 *
 * A category name is lowered only where it is an ordinary capitalized word, so
 * the phrase reads in sentence case without turning "AI" into "ai" or
 * "YouTube" into "youtube". An app held inside a category has that category
 * named ahead of it already, so it is just an app.
 */
export function scopeDescriptor(scope: InsightsScope, category: Category | null): string {
  if (scope.kind === "category") {
    return category ? `${categoryState(category)} category` : "category";
  }
  if (scope.within) return KIND_WORDS[scope.kind];
  return `${inSentence(category?.name ?? "Uncategorized")} ${KIND_WORDS[scope.kind]}`;
}

function inSentence(name: string): string {
  return name
    .split(" ")
    .map((word) => (/^[A-Z][a-z]*$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

/** Something the scope picker can offer, with the time it holds in range. */
export interface ScopeCandidate {
  scope: InsightsScope;
  seconds: number;
  /** The category the candidate's time mostly resolved to — itself, for a
   *  category. Null when that was uncategorized time. */
  category: Category | null;
  /** What was actually recorded under the name, for search: every process an
   *  app's alias gathers, lowercased, or a website's host. Empty for a
   *  category. */
  identities: string[];
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
  type Entry = {
    scope: InsightsScope;
    seconds: number;
    categories: Map<Category | null, number>;
    identities: Set<string>;
  };
  const categories = new Map<string, Entry>();
  const apps = new Map<string, Entry>();
  const websites = new Map<string, Entry>();
  const add = (
    into: Map<string, Entry>,
    key: string,
    make: () => InsightsScope,
    category: Category | null,
    seconds: number,
    identity?: string,
  ) => {
    let entry = into.get(key);
    if (!entry) {
      entry = { scope: make(), seconds: 0, categories: new Map(), identities: new Set() };
      into.set(key, entry);
    }
    if (identity) entry.identities.add(identity);
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
    }), category, seconds, session.process.toLowerCase());
    if (session.domain && context.browserProcesses.has(session.process.toLowerCase())) {
      const domain = session.domain.toLowerCase();
      add(websites, domain, () => ({
        kind: "website",
        key: domain,
        name: cleanDomainName(domain, context.aliases),
      }), category, seconds, domain);
    }
  }
  const ranked = (from: Map<string, Entry>): ScopeCandidate[] =>
    [...from.values()]
      .map(({ scope, seconds, categories: split, identities }) => {
        let category: Category | null = null;
        let most = 0;
        for (const [candidate, candidateSeconds] of split) {
          if (candidateSeconds > most) {
            most = candidateSeconds;
            category = candidate;
          }
        }
        return {
          scope,
          seconds,
          category,
          identities: [...identities].sort(),
        };
      })
      .sort((left, right) => right.seconds - left.seconds || left.scope.name.localeCompare(right.scope.name));
  return {
    categories: ranked(categories),
    apps: ranked(apps),
    websites: ranked(websites),
  };
}

/**
 * The candidates whose name, or anything recorded under it, contains the
 * query, each section still heaviest first and cut to `limits`. So an aliased
 * app is found by its alias or by its executable, and a website by its name or
 * its host. An empty query browses: the same cut, applied to everything.
 */
export function searchScopeCandidates(
  candidates: ScopeCandidates,
  query: string,
  limits: { categories: number; apps: number; websites: number },
): ScopeCandidates {
  const needle = query.trim().toLowerCase();
  const matches = (candidate: ScopeCandidate) =>
    candidate.scope.name.toLowerCase().includes(needle)
    || candidate.identities.some((identity) => identity.includes(needle));
  const pick = (list: ScopeCandidate[], limit: number) =>
    (needle ? list.filter(matches) : list).slice(0, limit);
  return {
    categories: pick(candidates.categories, limits.categories),
    apps: pick(candidates.apps, limits.apps),
    websites: pick(candidates.websites, limits.websites),
  };
}

/**
 * What a search found a candidate by, when it was not the name the list shows:
 * typing "r5apex" finds Apex Legends, and the row should say why. Null when
 * the name itself matches, or nothing is being searched for.
 */
export function matchedIdentity(candidate: ScopeCandidate, query: string): string | null {
  const needle = query.trim().toLowerCase();
  if (!needle || candidate.scope.name.toLowerCase().includes(needle)) return null;
  return candidate.identities.find((identity) => identity.includes(needle)) ?? null;
}
