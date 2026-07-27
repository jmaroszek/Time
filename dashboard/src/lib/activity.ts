import {
  buildClassificationExplainer,
  type Category,
  type MatchType,
  type Rule,
} from "./classify";
import { cleanDomainName, cleanProcessName } from "./format";
import type { Session } from "./metrics";
import { classifyNoise, type NoisePolicy, type NoiseReason } from "./noise";

export type ActivityEntityKind = "app" | "website";
export type ActivityStatus = "uncategorized" | "partial" | "mixed" | "single" | "ignored";
export type ActivityTypeFilter = "all" | ActivityEntityKind;
export type ActivitySort = "name" | "seconds" | "lastSeen" | "days";
export type ActivitySortDirection = "asc" | "desc";

export interface ActivitySource {
  sessions: Session[];
  categories: Category[];
  rules: Rule[];
  browserProcesses: string[];
  aliases: Record<string, string>;
}

export interface ActivityCategorySlice {
  categoryId: number;
  name: string;
  color: string;
  isIgnored: boolean;
  seconds: number;
}

export interface ActivityEntityRuleSlice {
  ruleId: number;
  matchType: MatchType;
  pattern: string;
  categoryId: number;
  categoryName: string;
  categoryColor: string;
  sessions: number;
  seconds: number;
}

export interface ActivityEntitySummary {
  id: string;
  kind: ActivityEntityKind;
  key: string;
  displayName: string;
  sourceProcesses: string[];
  seconds: number;
  sessionCount: number;
  /** Distinct local days the entity was seen on. Separates a habit from a
   *  binge, which equal totals and session counts cannot. */
  daysSeen: number;
  firstSeen: number;
  lastSeen: number;
  uncategorizedSeconds: number;
  categories: ActivityCategorySlice[];
  rules: ActivityEntityRuleSlice[];
  status: ActivityStatus;
  exactRuleId: number | null;
  /** Set by queryActivityIndex when the noise policy hides this entity. */
  noise: NoiseReason | null;
  /** Set by queryActivityIndex: first seen in all of history inside this range,
   *  so it is genuinely new rather than merely new to what is on screen. */
  isNew: boolean;
}

export interface ActivitySessionRow {
  id: number;
  start: number;
  end: number;
  seconds: number;
  process: string;
  title: string;
  domain: string | null;
  entityId: string;
  entityKind: ActivityEntityKind;
  entityKey: string;
  displayName: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIgnored: boolean;
  winningRuleId: number | null;
  winningRuleType: MatchType | null;
  winningRulePattern: string | null;
  classificationSource: "rule" | "session_override" | "none";
  isCorrected: boolean;
}

export type ActivityClassificationFilter =
  | "all"
  | "uncategorized"
  | "mixed"
  | "ignored"
  | `category:${number}`;

export interface ActivityQuery {
  startSec: number;
  endSec: number;
  search: string;
  typeFilter: ActivityTypeFilter;
  classificationFilter: ActivityClassificationFilter;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  entityOffset: number;
  entityLimit: number;
  windowOffset: number;
  windowLimit: number;
  /** Omitted means no hiding — the library function thresholds nothing on its own. */
  noise?: NoisePolicy;
  /** Show hidden rows anyway, tagged, without changing what counts as noise. */
  includeNoise?: boolean;
  selectedEntityId?: string | null;
  detailSearch?: string;
  detailOffset?: number;
  detailLimit?: number;
}

export interface ActivityEntityPage {
  rows: ActivityEntitySummary[];
  total: number;
}

export interface ActivitySessionPage {
  rows: ActivitySessionRow[];
  total: number;
}

/** Triage counter carried by the classification menu's Uncategorized option.
 *  Hidden rows are left out on purpose: uncategorized *and* noise-filtered is
 *  clutter, and a count on a filter must promise what picking it delivers. */
export interface ActivityUncategorizedSummary {
  entities: number;
  seconds: number;
}

export interface ActivityQueryResult {
  catalog: ActivityEntityPage;
  /** Entities the noise policy hides from the catalog, whether or not
   *  includeNoise is currently showing them. Zero while searching. */
  noiseHidden: number;
  /**
   * Sessions whose stored title contains the search text, newest first. Null
   * when nothing is being searched, because stored titles are never listed
   * until someone asks for them.
   *
   * Matching identities are not carried alongside: a search narrows `catalog`
   * in place, and `catalog` mixes apps and websites exactly as the unsearched
   * list does. Splitting them back into two tables under a search only
   * duplicated a distinction every row already states on its own metadata line
   * and the type filter already controls.
   */
  windowMatches: ActivitySessionPage | null;
  /** All recorded time in range, hidden and filtered rows included. Every
   *  session maps to exactly one entity, so summing them double-counts
   *  nothing. Backs the share each row reports, not the length it draws. */
  totalSeconds: number;
  /** The largest single row the current filters admit — what a full-length bar
   *  represents. Absolute share sets that length honestly but compresses every
   *  row into the same short stub, which is the one thing a bar exists to
   *  avoid; the true share moves to the row's tooltip instead. */
  maxSeconds: number;
  /** Entities with uncategorized time in range, after the noise and type
   *  filters — the same rows picking "Uncategorized" would land on. */
  uncategorized: ActivityUncategorizedSummary;
  selectedEntity: ActivityEntitySummary | null;
  detailSessions: ActivitySessionRow[];
  detailTotal: number;
  hasStoredTitles: boolean;
  appliedRuleIds: number[];
}

interface IndexedSession extends ActivitySessionRow {
  rawSeconds: number;
}

export interface ActivityIndex {
  sessions: IndexedSession[];
  categories: Category[];
  rules: Rule[];
  exactRuleByEntity: Map<string, number>;
  /** Stable all-history summaries used only to decide whether an item is rare. */
  lifetimeEntities: Map<string, ActivityEntitySummary>;
  hasStoredTitles: boolean;
  /** Rules that won at least one session in all of history. A rule missing here
   *  is the one actionable usage signal left: nothing matches it, so it is a
   *  deletion candidate. Per-rule detail lives in the entity drawer instead. */
  appliedRuleIds: number[];
}

interface MutableEntity {
  id: string;
  kind: ActivityEntityKind;
  key: string;
  displayName: string;
  sourceProcesses: Set<string>;
  seconds: number;
  sessionCount: number;
  days: Set<number>;
  firstSeen: number;
  lastSeen: number;
  uncategorizedSeconds: number;
  categorySeconds: Map<number, number>;
  ruleUsage: Map<number, { sessions: number; seconds: number }>;
}

/**
 * Records every local calendar day a session covers, not just the one it
 * started on: a session running past midnight was real activity on both days.
 * Stepping with setDate keeps the walk correct across DST, where a day is not
 * 86400 seconds long.
 */
function addDayKeys(target: Set<number>, startSec: number, endSec: number): void {
  const cursor = new Date(startSec * 1000);
  cursor.setHours(0, 0, 0, 0);
  // Strictly less than: a session ending exactly at midnight touched the next
  // day for no time at all.
  while (cursor.getTime() / 1000 < endSec) {
    target.add(cursor.getFullYear() * 10000 + (cursor.getMonth() + 1) * 100 + cursor.getDate());
    cursor.setDate(cursor.getDate() + 1);
  }
}

function entityIdentity(
  session: Session,
  browserProcesses: Set<string>,
): { id: string; kind: ActivityEntityKind; key: string } {
  const process = session.process.toLowerCase();
  if (browserProcesses.has(process) && session.domain) {
    const key = session.domain.toLowerCase();
    return { id: `website:${key}`, kind: "website", key };
  }
  return { id: `app:${process}`, kind: "app", key: process };
}

function activityDisplayName(
  kind: ActivityEntityKind,
  key: string,
  aliases: Record<string, string>,
): string {
  return kind === "app" ? cleanProcessName(key, aliases) : cleanDomainName(key, aliases);
}

export function buildActivityIndex(source: ActivitySource): ActivityIndex {
  const browserProcesses = new Set(source.browserProcesses.map((process) => process.toLowerCase()));
  const explain = buildClassificationExplainer(source.categories, source.rules, browserProcesses);
  const indexed: IndexedSession[] = [];
  const appliedRuleIds = new Set<number>();
  let hasStoredTitles = false;

  for (const session of source.sessions) {
    if (session.isAfk || session.end <= session.start) continue;
    const identity = entityIdentity(session, browserProcesses);
    const explanation = explain(session);
    const seconds = session.end - session.start;
    if (session.title) hasStoredTitles = true;
    if (explanation.winningRule) appliedRuleIds.add(explanation.winningRule.id);
    indexed.push({
      id: session.id,
      start: session.start,
      end: session.end,
      seconds,
      rawSeconds: seconds,
      process: session.process,
      title: session.title,
      domain: session.domain,
      entityId: identity.id,
      entityKind: identity.kind,
      entityKey: identity.key,
      displayName: activityDisplayName(identity.kind, identity.key, source.aliases),
      categoryId: explanation.category?.id ?? null,
      categoryName: explanation.category?.name ?? null,
      categoryColor: explanation.category?.color ?? null,
      categoryIgnored: explanation.category?.isIgnored ?? false,
      winningRuleId: explanation.winningRule?.id ?? null,
      winningRuleType: explanation.winningRule?.matchType ?? null,
      winningRulePattern: explanation.winningRule?.pattern ?? null,
      classificationSource: explanation.source,
      isCorrected: session.isCorrected ?? false,
    });
  }

  const exactRuleByEntity = new Map<string, number>();
  for (const rule of source.rules) {
    const entityId = rule.matchType === "process"
      ? `app:${rule.pattern.toLowerCase()}`
      : rule.matchType === "domain"
        ? `website:${rule.pattern.toLowerCase()}`
        : null;
    if (entityId !== null && !exactRuleByEntity.has(entityId)) exactRuleByEntity.set(entityId, rule.id);
  }
  const index: ActivityIndex = {
    sessions: indexed,
    categories: source.categories,
    rules: source.rules,
    exactRuleByEntity,
    lifetimeEntities: new Map(),
    hasStoredTitles,
    appliedRuleIds: [...appliedRuleIds],
  };
  index.lifetimeEntities = new Map(
    aggregateEntities(index, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
      .map((entity) => [entity.id, entity] as const),
  );
  return index;
}

function aggregateEntities(index: ActivityIndex, startSec: number, endSec: number): ActivityEntitySummary[] {
  const mutable = new Map<string, MutableEntity>();
  for (const session of index.sessions) {
    const start = Math.max(session.start, startSec);
    const end = Math.min(session.end, endSec);
    if (end <= start) continue;
    const seconds = end - start;
    let entity = mutable.get(session.entityId);
    if (!entity) {
      entity = {
        id: session.entityId,
        kind: session.entityKind,
        key: session.entityKey,
        displayName: session.displayName,
        sourceProcesses: new Set<string>(),
        seconds: 0,
        sessionCount: 0,
        days: new Set<number>(),
        firstSeen: start,
        lastSeen: end,
        uncategorizedSeconds: 0,
        categorySeconds: new Map<number, number>(),
        ruleUsage: new Map<number, { sessions: number; seconds: number }>(),
      };
      mutable.set(session.entityId, entity);
    }
    entity.sourceProcesses.add(session.process);
    entity.seconds += seconds;
    entity.sessionCount += 1;
    addDayKeys(entity.days, start, end);
    entity.firstSeen = Math.min(entity.firstSeen, start);
    entity.lastSeen = Math.max(entity.lastSeen, end);
    if (session.categoryId === null) entity.uncategorizedSeconds += seconds;
    else entity.categorySeconds.set(
      session.categoryId,
      (entity.categorySeconds.get(session.categoryId) ?? 0) + seconds,
    );
    if (session.winningRuleId !== null) {
      const usage = entity.ruleUsage.get(session.winningRuleId) ?? { sessions: 0, seconds: 0 };
      usage.sessions += 1;
      usage.seconds += seconds;
      entity.ruleUsage.set(session.winningRuleId, usage);
    }
  }

  const categoriesById = new Map(index.categories.map((category) => [category.id, category]));
  const rulesById = new Map(index.rules.map((rule) => [rule.id, rule]));
  return [...mutable.values()].map((entity) => {
    const categories = [...entity.categorySeconds]
      .map(([categoryId, seconds]) => {
        const category = categoriesById.get(categoryId);
        return category
          ? {
              categoryId,
              name: category.name,
              color: category.color,
              isIgnored: category.isIgnored,
              seconds,
            }
          : null;
      })
      .filter((slice): slice is ActivityCategorySlice => slice !== null)
      .sort((left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name));
    const rules = [...entity.ruleUsage]
      .map(([ruleId, usage]) => {
        const rule = rulesById.get(ruleId);
        const category = rule ? categoriesById.get(rule.categoryId) : null;
        return rule && category
          ? {
              ruleId,
              matchType: rule.matchType,
              pattern: rule.pattern,
              categoryId: category.id,
              categoryName: category.name,
              categoryColor: category.color,
              sessions: usage.sessions,
              seconds: usage.seconds,
            }
          : null;
      })
      .filter((slice): slice is ActivityEntityRuleSlice => slice !== null)
      .sort((left, right) => right.seconds - left.seconds || left.ruleId - right.ruleId);
    let status: ActivityStatus;
    if (entity.uncategorizedSeconds >= entity.seconds) status = "uncategorized";
    else if (entity.uncategorizedSeconds > 0) status = "partial";
    else if (categories.length > 0 && categories.every((category) => category.isIgnored)) status = "ignored";
    else if (categories.length > 1) status = "mixed";
    else status = "single";
    return {
      id: entity.id,
      kind: entity.kind,
      key: entity.key,
      displayName: entity.displayName,
      sourceProcesses: [...entity.sourceProcesses].sort(),
      seconds: entity.seconds,
      sessionCount: entity.sessionCount,
      daysSeen: entity.days.size,
      firstSeen: entity.firstSeen,
      lastSeen: entity.lastSeen,
      uncategorizedSeconds: entity.uncategorizedSeconds,
      categories,
      rules,
      status,
      exactRuleId: index.exactRuleByEntity.get(entity.id) ?? null,
      noise: null,
      isNew: false,
    };
  });
}

function matchesClassification(
  entity: ActivityEntitySummary,
  filter: ActivityClassificationFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "uncategorized") return entity.uncategorizedSeconds > 0;
  if (filter === "mixed") return entity.status === "mixed";
  if (filter === "ignored") return entity.status === "ignored";
  const categoryId = Number(filter.slice("category:".length));
  return entity.categories.some((category) => category.categoryId === categoryId);
}

function compareEntities(
  sort: ActivitySort,
  direction: ActivitySortDirection,
): (left: ActivityEntitySummary, right: ActivityEntitySummary) => number {
  const sign = direction === "asc" ? 1 : -1;
  return (left, right) => {
    let comparison = 0;
    if (sort === "name") comparison = left.displayName.localeCompare(right.displayName);
    else if (sort === "seconds") comparison = left.seconds - right.seconds;
    else if (sort === "lastSeen") comparison = left.lastSeen - right.lastSeen;
    else comparison = left.daysSeen - right.daysSeen;
    return comparison * sign || left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
  };
}

function uncategorizedSummary(entities: ActivityEntitySummary[]): ActivityUncategorizedSummary {
  const pending = entities.filter(
    (entity) => entity.uncategorizedSeconds > 0 && entity.noise === null,
  );
  return {
    entities: pending.length,
    seconds: pending.reduce((total, entity) => total + entity.uncategorizedSeconds, 0),
  };
}

function clippedSession(session: IndexedSession, startSec: number, endSec: number): ActivitySessionRow | null {
  const start = Math.max(session.start, startSec);
  const end = Math.min(session.end, endSec);
  if (end <= start) return null;
  const { rawSeconds: _rawSeconds, ...row } = session;
  return { ...row, start, end, seconds: end - start };
}

function page<T>(rows: T[], offset: number, limit: number): T[] {
  return rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));
}

export function queryActivityIndex(index: ActivityIndex, query: ActivityQuery): ActivityQueryResult {
  const policy = query.noise;
  const visibleEntities = aggregateEntities(index, query.startSec, query.endSec);
  // "New" means new to your history, not new to what the range happens to show.
  // A range reaching back to the very first session therefore has no new items
  // at all, which is the honest answer rather than every row wearing the tag.
  let earliestEver = Number.POSITIVE_INFINITY;
  for (const lifetime of index.lifetimeEntities.values()) {
    earliestEver = Math.min(earliestEver, lifetime.firstSeen);
  }
  const canBeNew = query.startSec > earliestEver;
  const allEntities = visibleEntities.map((entity) => {
    const lifetime = index.lifetimeEntities.get(entity.id) ?? entity;
    return {
      ...entity,
      // Rarity is a property of the full history, not of whichever date
      // range happens to be visible. The row's displayed totals stay scoped.
      noise: policy ? classifyNoise(lifetime, policy) : null,
      isNew: canBeNew && lifetime.firstSeen >= query.startSec,
    };
  });
  const totalSeconds = allEntities.reduce((total, entity) => total + entity.seconds, 0);
  const entitiesById = new Map(allEntities.map((entity) => [entity.id, entity]));
  const inType = (entity: ActivityEntitySummary) =>
    query.typeFilter === "all" || entity.kind === query.typeFilter;
  const classificationFiltered = allEntities.filter((entity) =>
    matchesClassification(entity, query.classificationFilter),
  );
  const typeFiltered = classificationFiltered.filter(inType);
  const search = query.search.trim().toLowerCase();
  // Search deliberately reaches past the filter: someone typing "setup" is
  // looking for exactly the thing the list hides, and finding nothing would
  // read as missing data.
  const noiseHidden = search ? 0 : typeFiltered.filter((entity) => entity.noise !== null).length;
  const unfolded = noiseHidden > 0 && !query.includeNoise
    ? typeFiltered.filter((entity) => entity.noise === null)
    : typeFiltered;
  const sorted = [...unfolded].sort(compareEntities(query.sort, query.direction));
  const identityMatches = search
    ? sorted.filter((entity) =>
        entity.displayName.toLowerCase().includes(search) ||
        entity.key.toLowerCase().includes(search) ||
        entity.sourceProcesses.some((process) => process.toLowerCase().includes(search)),
      )
    : sorted;

  // Measured over every row the filters admit, not the loaded page, so the bar
  // scale is fixed the moment the filters are: pressing Load more must never
  // rescale the rows already on screen. Search groups share it too, which is
  // what keeps an app's bar comparable with a website's.
  const maxSeconds = identityMatches.reduce((most, entity) => Math.max(most, entity.seconds), 0);

  const catalog = {
    rows: page(identityMatches, query.entityOffset, query.entityLimit),
    total: identityMatches.length,
  };

  // Titles are matched regardless of the type filter, since a stored title has
  // no kind of its own — the browser session that carries one is filed under a
  // website, and the app filter would throw away the very rows a title search
  // is for. The view labels that exception rather than hiding it.
  let windowMatches: ActivitySessionPage | null = null;
  if (search) {
    const matching: ActivitySessionRow[] = [];
    for (const session of index.sessions) {
      if (!session.title.toLowerCase().includes(search)) continue;
      const entity = entitiesById.get(session.entityId);
      if (!entity || !matchesClassification(entity, query.classificationFilter)) continue;
      const clipped = clippedSession(session, query.startSec, query.endSec);
      if (clipped) matching.push(clipped);
    }
    matching.sort((left, right) => right.start - left.start || right.id - left.id);
    windowMatches = {
      rows: page(matching, query.windowOffset, query.windowLimit),
      total: matching.length,
    };
  }

  const selectedEntity = query.selectedEntityId
    ? (entitiesById.get(query.selectedEntityId) ?? null)
    : null;
  const detailSearch = query.detailSearch?.trim().toLowerCase() ?? "";
  const detailRows: ActivitySessionRow[] = [];
  if (selectedEntity) {
    for (const session of index.sessions) {
      if (session.entityId !== selectedEntity.id) continue;
      if (detailSearch && !session.title.toLowerCase().includes(detailSearch)) continue;
      const clipped = clippedSession(session, query.startSec, query.endSec);
      if (clipped) detailRows.push(clipped);
    }
    detailRows.sort((left, right) => right.start - left.start || right.id - left.id);
  }
  const exposeDetailTitles = detailSearch.length > 0;

  return {
    catalog,
    noiseHidden,
    windowMatches,
    totalSeconds,
    maxSeconds,
    // Deliberately not classification-filtered: the count labels the option
    // that applies that filter, so reading it from an already-filtered set
    // would zero it the moment any other classification was chosen.
    uncategorized: uncategorizedSummary(allEntities.filter(inType)),
    selectedEntity,
    detailSessions: page(detailRows, query.detailOffset ?? 0, query.detailLimit ?? 50).map(
      (session) => exposeDetailTitles ? session : { ...session, title: "" },
    ),
    detailTotal: detailRows.length,
    hasStoredTitles: index.hasStoredTitles,
    appliedRuleIds: index.appliedRuleIds,
  };
}

export interface PackedActivitySource {
  ids: Float64Array;
  starts: Float64Array;
  ends: Float64Array;
  processIndices: Uint32Array;
  titleIndices: Uint32Array;
  domainIndices: Int32Array;
  isAfk: Uint8Array;
  categoryOverrideIds: Int32Array;
  isCorrected: Uint8Array;
  processes: string[];
  titles: string[];
  domains: string[];
  categories: Category[];
  rules: Rule[];
  browserProcesses: string[];
  aliases: Record<string, string>;
}

export type ActivityClassificationSource = Pick<
  ActivitySource,
  "categories" | "rules" | "browserProcesses" | "aliases"
>;

function intern(value: string, values: string[], indices: Map<string, number>): number {
  const existing = indices.get(value);
  if (existing !== undefined) return existing;
  const index = values.length;
  values.push(value);
  indices.set(value, index);
  return index;
}

export function packActivitySource(source: ActivitySource): PackedActivitySource {
  const count = source.sessions.length;
  const processes: string[] = [];
  const titles: string[] = [""];
  const domains: string[] = [];
  const processMap = new Map<string, number>();
  const titleMap = new Map<string, number>([["", 0]]);
  const domainMap = new Map<string, number>();
  const packed: PackedActivitySource = {
    ids: new Float64Array(count),
    starts: new Float64Array(count),
    ends: new Float64Array(count),
    processIndices: new Uint32Array(count),
    titleIndices: new Uint32Array(count),
    domainIndices: new Int32Array(count).fill(-1),
    isAfk: new Uint8Array(count),
    categoryOverrideIds: new Int32Array(count).fill(-1),
    isCorrected: new Uint8Array(count),
    processes,
    titles,
    domains,
    categories: source.categories,
    rules: source.rules,
    browserProcesses: source.browserProcesses,
    aliases: source.aliases,
  };
  source.sessions.forEach((session, index) => {
    packed.ids[index] = session.id;
    packed.starts[index] = session.start;
    packed.ends[index] = session.end;
    packed.processIndices[index] = intern(session.process, processes, processMap);
    packed.titleIndices[index] = intern(session.title, titles, titleMap);
    if (session.domain !== null) packed.domainIndices[index] = intern(session.domain, domains, domainMap);
    packed.isAfk[index] = session.isAfk ? 1 : 0;
    if (session.categoryOverrideId != null) packed.categoryOverrideIds[index] = session.categoryOverrideId;
    packed.isCorrected[index] = session.isCorrected ? 1 : 0;
  });
  return packed;
}

export function unpackActivitySource(packed: PackedActivitySource): ActivitySource {
  const count = packed.ids.length;
  if (
    packed.starts.length !== count ||
    packed.ends.length !== count ||
    packed.processIndices.length !== count ||
    packed.titleIndices.length !== count ||
    packed.domainIndices.length !== count ||
    packed.isAfk.length !== count ||
    packed.categoryOverrideIds.length !== count ||
    packed.isCorrected.length !== count
  ) {
    throw new Error("Packed Activity columns have mismatched lengths");
  }
  return {
    sessions: Array.from({ length: count }, (_, index) => ({
      id: packed.ids[index],
      start: packed.starts[index],
      end: packed.ends[index],
      process: packed.processes[packed.processIndices[index]] ?? "",
      title: packed.titles[packed.titleIndices[index]] ?? "",
      domain: packed.domainIndices[index] >= 0 ? (packed.domains[packed.domainIndices[index]] ?? null) : null,
      isAfk: packed.isAfk[index] !== 0,
      categoryOverrideId: packed.categoryOverrideIds[index] >= 0 ? packed.categoryOverrideIds[index] : null,
      isCorrected: packed.isCorrected[index] !== 0,
    })),
    categories: packed.categories,
    rules: packed.rules,
    browserProcesses: packed.browserProcesses,
    aliases: packed.aliases,
  };
}

export type ActivityWorkerRequest = {
  id: number;
  sessionKey: string;
  classificationKey: string;
  source?: PackedActivitySource;
  classification: ActivityClassificationSource;
  query: ActivityQuery;
};

export type ActivityWorkerResponse =
  | { id: number; result: ActivityQueryResult }
  | { id: number; error: string };
