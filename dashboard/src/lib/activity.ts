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
export type ActivitySort = "name" | "seconds" | "lastSeen" | "sessions";
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

export interface ActivityRuleUsage {
  ruleId: number;
  sessions: number;
  seconds: number;
  lastUsed: number;
}

export interface ActivityCategoryUsage {
  categoryId: number;
  sessions: number;
  seconds: number;
  lastUsed: number;
}

export interface ActivityEntitySummary {
  id: string;
  kind: ActivityEntityKind;
  key: string;
  displayName: string;
  sourceProcesses: string[];
  seconds: number;
  sessionCount: number;
  firstSeen: number;
  lastSeen: number;
  uncategorizedSeconds: number;
  categories: ActivityCategorySlice[];
  rules: ActivityEntityRuleSlice[];
  status: ActivityStatus;
  exactRuleId: number | null;
  /** Set by queryActivityIndex when the noise policy folds this entity away. */
  noise: NoiseReason | null;
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
  | "needs_attention"
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
  /** Omitted means no folding — the library function thresholds nothing on its own. */
  noise?: NoisePolicy;
  /** Show folded rows anyway, tagged, without changing what counts as noise. */
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

export interface ActivitySearchResults {
  apps: ActivityEntityPage;
  websites: ActivityEntityPage;
  windowMatches: ActivitySessionRow[];
  windowTotal: number;
}

export interface ActivityAttentionSummary {
  entities: number;
  seconds: number;
}

export interface ActivityQueryResult {
  catalog: ActivityEntityPage;
  /** Entities the noise policy folds out of the catalog, whether or not
   *  includeNoise is currently showing them. Zero while searching. */
  noiseHidden: number;
  searchResults: ActivitySearchResults | null;
  needsAttention: ActivityEntitySummary[];
  needsAttentionTotal: number;
  currentAttention: ActivityAttentionSummary;
  allHistoryAttention: ActivityAttentionSummary;
  selectedEntity: ActivityEntitySummary | null;
  detailSessions: ActivitySessionRow[];
  detailTotal: number;
  hasStoredTitles: boolean;
  ruleUsage: ActivityRuleUsage[];
  categoryUsage: ActivityCategoryUsage[];
}

interface IndexedSession extends ActivitySessionRow {
  rawSeconds: number;
}

export interface ActivityIndex {
  sessions: IndexedSession[];
  categories: Category[];
  rules: Rule[];
  exactRuleByEntity: Map<string, number>;
  hasStoredTitles: boolean;
  ruleUsage: ActivityRuleUsage[];
  categoryUsage: ActivityCategoryUsage[];
  allHistoryAttention: ActivityAttentionSummary;
}

interface MutableEntity {
  id: string;
  kind: ActivityEntityKind;
  key: string;
  displayName: string;
  sourceProcesses: Set<string>;
  seconds: number;
  sessionCount: number;
  firstSeen: number;
  lastSeen: number;
  uncategorizedSeconds: number;
  categorySeconds: Map<number, number>;
  ruleUsage: Map<number, { sessions: number; seconds: number }>;
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

function incrementUsage<T extends { sessions: number; seconds: number; lastUsed: number }>(
  map: Map<number, T>,
  key: number,
  make: () => T,
  seconds: number,
  lastUsed: number,
): void {
  const usage = map.get(key) ?? make();
  usage.sessions += 1;
  usage.seconds += seconds;
  usage.lastUsed = Math.max(usage.lastUsed, lastUsed);
  map.set(key, usage);
}

export function buildActivityIndex(source: ActivitySource): ActivityIndex {
  const browserProcesses = new Set(source.browserProcesses.map((process) => process.toLowerCase()));
  const explain = buildClassificationExplainer(source.categories, source.rules, browserProcesses);
  const indexed: IndexedSession[] = [];
  const ruleUsage = new Map<number, ActivityRuleUsage>();
  const categoryUsage = new Map<number, ActivityCategoryUsage>();
  let hasStoredTitles = false;

  for (const session of source.sessions) {
    if (session.isAfk || session.end <= session.start) continue;
    const identity = entityIdentity(session, browserProcesses);
    const explanation = explain(session);
    const seconds = session.end - session.start;
    if (session.title) hasStoredTitles = true;
    if (explanation.winningRule) {
      incrementUsage(
        ruleUsage,
        explanation.winningRule.id,
        () => ({ ruleId: explanation.winningRule!.id, sessions: 0, seconds: 0, lastUsed: 0 }),
        seconds,
        session.end,
      );
    }
    if (explanation.category) {
      incrementUsage(
        categoryUsage,
        explanation.category.id,
        () => ({ categoryId: explanation.category!.id, sessions: 0, seconds: 0, lastUsed: 0 }),
        seconds,
        session.end,
      );
    }
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
    hasStoredTitles,
    ruleUsage: [...ruleUsage.values()],
    categoryUsage: [...categoryUsage.values()],
    allHistoryAttention: { entities: 0, seconds: 0 },
  };
  const allEntities = aggregateEntities(index, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  index.allHistoryAttention = attentionSummary(allEntities);
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
      firstSeen: entity.firstSeen,
      lastSeen: entity.lastSeen,
      uncategorizedSeconds: entity.uncategorizedSeconds,
      categories,
      rules,
      status,
      exactRuleId: index.exactRuleByEntity.get(entity.id) ?? null,
      noise: null,
    };
  });
}

function matchesClassification(
  entity: ActivityEntitySummary,
  filter: ActivityClassificationFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "needs_attention") return entity.uncategorizedSeconds > 0;
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
    else comparison = left.sessionCount - right.sessionCount;
    return comparison * sign || left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
  };
}

function attentionSummary(entities: ActivityEntitySummary[]): ActivityAttentionSummary {
  const needingAttention = entities.filter((entity) => entity.uncategorizedSeconds > 0);
  return {
    entities: needingAttention.length,
    seconds: needingAttention.reduce((total, entity) => total + entity.uncategorizedSeconds, 0),
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
  const allEntities = policy
    ? aggregateEntities(index, query.startSec, query.endSec).map((entity) => ({
        ...entity,
        noise: classifyNoise(entity, policy),
      }))
    : aggregateEntities(index, query.startSec, query.endSec);
  const entitiesById = new Map(allEntities.map((entity) => [entity.id, entity]));
  const classificationFiltered = allEntities.filter((entity) =>
    matchesClassification(entity, query.classificationFilter),
  );
  const typeFiltered = classificationFiltered.filter(
    (entity) => query.typeFilter === "all" || entity.kind === query.typeFilter,
  );
  const search = query.search.trim().toLowerCase();
  // Search deliberately reaches past the fold: someone typing "setup" is
  // looking for exactly the thing the fold hides, and finding nothing would
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

  const catalog = {
    rows: page(identityMatches, query.entityOffset, query.entityLimit),
    total: identityMatches.length,
  };

  let searchResults: ActivitySearchResults | null = null;
  if (search) {
    const apps = identityMatches.filter((entity) => entity.kind === "app");
    const websites = identityMatches.filter((entity) => entity.kind === "website");
    const matchingWindows: ActivitySessionRow[] = [];
    for (const session of index.sessions) {
      if (!session.title.toLowerCase().includes(search)) continue;
      const entity = entitiesById.get(session.entityId);
      if (!entity || !matchesClassification(entity, query.classificationFilter)) continue;
      const clipped = clippedSession(session, query.startSec, query.endSec);
      if (clipped) matchingWindows.push(clipped);
    }
    matchingWindows.sort((left, right) => right.start - left.start || right.id - left.id);
    searchResults = {
      apps: { rows: page(apps, query.entityOffset, query.entityLimit), total: apps.length },
      websites: { rows: page(websites, query.entityOffset, query.entityLimit), total: websites.length },
      windowMatches: page(matchingWindows, query.windowOffset, query.windowLimit),
      windowTotal: matchingWindows.length,
    };
  }

  const attention = allEntities
    .filter((entity) => entity.uncategorizedSeconds > 0)
    .sort((left, right) => right.uncategorizedSeconds - left.uncategorizedSeconds || left.displayName.localeCompare(right.displayName));
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
    searchResults,
    needsAttention: attention.slice(0, 6),
    needsAttentionTotal: attention.length,
    currentAttention: attentionSummary(allEntities),
    allHistoryAttention: index.allHistoryAttention,
    selectedEntity,
    detailSessions: page(detailRows, query.detailOffset ?? 0, query.detailLimit ?? 50).map(
      (session) => exposeDetailTitles ? session : { ...session, title: "" },
    ),
    detailTotal: detailRows.length,
    hasStoredTitles: index.hasStoredTitles,
    ruleUsage: index.ruleUsage,
    categoryUsage: index.categoryUsage,
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
