import {
  buildClassificationExplainer,
  type Category,
  type MatchType,
  type Rule,
} from "./classify";
import { cleanDomainName, cleanProcessName } from "./format";
import type { Session } from "./metrics";
import { classifyNoise, type NoisePolicy, type NoiseReason } from "./noise";
import { normalizeWindowTitle } from "./titleRules";

export type ActivityEntityKind = "app" | "website";
export type ActivityStatus = "uncategorized" | "partial" | "mixed" | "single" | "ignored";
export type ActivityTypeFilter = "all" | ActivityEntityKind;
export type ActivitySort = "name" | "seconds" | "lastSeen" | "days";
export type ActivitySortDirection = "asc" | "desc";
export type ActivityWindowSort = "title" | "seconds" | "days" | "lastSeen";

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
  windowSort: ActivityWindowSort;
  windowDirection: ActivitySortDirection;
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
  /** Order for the selected entity's own window list. Independent of the
   *  search results' order: one is a reader working through what a single app
   *  was used for, the other a reader scanning matches across everything. */
  detailSort?: ActivityWindowSort;
  detailDirection?: ActivitySortDirection;
  /** The one window being inspected, which is allowed more of its own visits
   *  than the summary sample every other group carries. */
  selectedWindowKey?: string | null;
  selectedWindowSessionLimit?: number;
}

export interface ActivityEntityPage {
  rows: ActivityEntitySummary[];
  total: number;
  /** Complete filtered totals, not merely the currently loaded page. */
  apps: number;
  websites: number;
}

/** Sessions carried inside a group for inspection. A group is a summary first;
 *  this is enough to check a few rows without shipping thousands across the
 *  worker boundary, and the group reports its true count either way. */
export const GROUP_SESSION_SAMPLE = 25;

/** Joins an entity id to a normalized title into one map key. NUL cannot occur
 *  in either half — normalization strips controls — so no pair of different
 *  (entity, title) values can collide on the joined string. Written as an
 *  escape because a literal NUL in source is invisible and makes the file read
 *  as binary. */
const GROUP_KEY_SEP = "\u0000";

/**
 * One window title, and every visit to it.
 *
 * A session row is the tracker's honest storage unit — one uninterrupted spell
 * in the foreground — but it is a poor thing to read. Half of a typical
 * database's rows are under ten seconds and together they carry a few percent
 * of its time, so a title search answered row by row returns hundreds of
 * fragments of what a person thinks of as one thing. Grouping restores the
 * unit someone actually meant: this window, this many visits, this much time.
 */
export interface ActivityTitleGroup {
  /** Identity plus normalized full title. Stable across cosmetic title
   *  changes, so it can key both a React list and an expanded-group selection. */
  key: string;
  entityId: string;
  entityKind: ActivityEntityKind;
  entityKey: string;
  /** The entity's friendly name — "Obsidian", not "obsidian.exe". */
  displayName: string;
  /** Newest original spelling among the grouped sessions. */
  title: string;
  /** Every visit, not just the sampled ones. */
  sessionCount: number;
  seconds: number;
  /** Distinct local days represented by every visit in the group. */
  daysSeen: number;
  firstSeen: number;
  lastSeen: number;
  /** First appeared in all history inside the selected range. */
  isNew: boolean;
  /** All of them, so ticking a group can select every visit it stands for
   *  without a second round trip. Numbers are cheap; rows are not. */
  sessionIds: number[];
  /** Newest first, capped at GROUP_SESSION_SAMPLE. */
  sessions: ActivitySessionRow[];
  /** Null when the group's sessions disagree or none is categorized. */
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  /** The group's sessions resolve to different categories. */
  mixed: boolean;
  /** Classification membership across every visit. These keep Library filters
   *  honest without reducing a matching Window to a partial subtotal. */
  categoryIds: number[];
  hasUncategorized: boolean;
  allIgnored: boolean;
  /** The category agrees, but the rule or manual-correction source does not. */
  provenanceMixed: boolean;
  /** Null when provenance varies across visits. */
  classificationSource: ActivitySessionRow["classificationSource"] | null;
  /** The rule deciding the group, when they agree. Shows at a glance whether a
   *  Window rule is doing any work here. */
  winningRuleType: MatchType | null;
  winningRulePattern: string | null;
}

export interface ActivityTitleGroupPage {
  rows: ActivityTitleGroup[];
  /** Distinct normalized titles, which is what `rows` is a page of. */
  total: number;
  /** Sessions behind every group, paged or not — what the old flat list
   *  would have shown, kept so the view can say what it collapsed. */
  sessionTotal: number;
  /** The heaviest group in the whole list, not merely on this page: a bar
   *  drawn against the loaded page alone would rescale every time the reader
   *  pressed "load more", or whenever a sort put a lighter row first. */
  maxSeconds: number;
}

/**
 * One column of the detail panel's usage strip: how much of the selected
 * entity's time landed in a span of local calendar days.
 *
 * Days are kept even when empty, because a gap is most of what the strip is
 * for. Several days fold into one column once a range holds more of them than
 * a strip can draw, which is what keeps an all-time range one readable row
 * instead of a thousand hairlines.
 */
export interface ActivityDayBucket {
  startSec: number;
  /** Exclusive, and clipped to the query's end so the last column cannot
   *  claim a span the range never covered. */
  endSec: number;
  /** Whole local days this column stands for, so the view can label it. */
  days: number;
  seconds: number;
}

/** Columns the strip draws at most. Beyond this a column is under a pixel
 *  wide in the panel, so days start folding together instead. */
export const USAGE_STRIP_COLUMNS = 60;

/**
 * Collapse sessions into one row per conservatively normalized full title,
 * ordered by total time so the heaviest window leads. Sessions arrive
 * newest-first, so the first original title becomes the representative label
 * and that order is preserved inside each group.
 */
function titleGroupKey(session: Pick<ActivitySessionRow, "entityId" | "title">): string {
  return `${session.entityId}${GROUP_KEY_SEP}${normalizeWindowTitle(session.title)}`;
}

function groupSessionsByTitle(sessions: ActivitySessionRow[]): ActivityTitleGroup[] {
  const groups = new Map<string, ActivityTitleGroup>();
  const daysByGroup = new Map<string, Set<number>>();
  for (const session of sessions) {
    // Entity as well as title: "Inbox" in a browser and "Inbox" in a mail
    // client are different activities that happen to share a word.
    const key = titleGroupKey(session);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        entityId: session.entityId,
        entityKind: session.entityKind,
        entityKey: session.entityKey,
        displayName: session.displayName,
        title: session.title,
        sessionCount: 0,
        seconds: 0,
        daysSeen: 0,
        firstSeen: session.start,
        lastSeen: session.end,
        isNew: false,
        sessionIds: [],
        sessions: [],
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        categoryColor: session.categoryColor,
        mixed: false,
        categoryIds: [],
        hasUncategorized: false,
        allIgnored: true,
        provenanceMixed: false,
        classificationSource: session.classificationSource,
        winningRuleType: session.winningRuleType,
        winningRulePattern: session.winningRulePattern,
      };
      groups.set(key, group);
      daysByGroup.set(key, new Set());
    }
    group.sessionCount += 1;
    group.seconds += session.seconds;
    group.firstSeen = Math.min(group.firstSeen, session.start);
    group.lastSeen = Math.max(group.lastSeen, session.end);
    if (session.categoryId === null) group.hasUncategorized = true;
    else if (!group.categoryIds.includes(session.categoryId)) group.categoryIds.push(session.categoryId);
    group.allIgnored &&= session.categoryId !== null && session.categoryIgnored;
    addDayKeys(daysByGroup.get(key)!, session.start, session.end);
    group.sessionIds.push(session.id);
    if (group.sessions.length < GROUP_SESSION_SAMPLE) group.sessions.push(session);
    if (!group.mixed && session.categoryId !== group.categoryId) {
      group.mixed = true;
      group.categoryId = null;
      group.categoryName = null;
      group.categoryColor = null;
      group.classificationSource = null;
      group.winningRuleType = null;
      group.winningRulePattern = null;
    } else if (
      !group.mixed
      && !group.provenanceMixed
      && (
        session.classificationSource !== group.classificationSource
        || session.winningRuleType !== group.winningRuleType
        || session.winningRulePattern !== group.winningRulePattern
      )
    ) {
      group.provenanceMixed = true;
      group.classificationSource = null;
      group.winningRuleType = null;
      group.winningRulePattern = null;
    }
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.daysSeen = daysByGroup.get(group.key)?.size ?? 0;
    group.categoryIds.sort((left, right) => left - right);
  }
  return result.sort(
    (left, right) => right.seconds - left.seconds || right.lastSeen - left.lastSeen,
  );
}

function compareTitleGroups(
  sort: ActivityWindowSort,
  direction: ActivitySortDirection,
): (left: ActivityTitleGroup, right: ActivityTitleGroup) => number {
  const sign = direction === "asc" ? 1 : -1;
  return (left, right) => {
    const leftTitle = normalizeWindowTitle(left.title);
    const rightTitle = normalizeWindowTitle(right.title);
    let comparison = 0;
    if (sort === "title") comparison = leftTitle.localeCompare(rightTitle);
    else if (sort === "seconds") comparison = left.seconds - right.seconds;
    else if (sort === "days") comparison = left.daysSeen - right.daysSeen;
    else comparison = left.lastSeen - right.lastSeen;
    return comparison * sign
      || leftTitle.localeCompare(rightTitle)
      || left.entityId.localeCompare(right.entityId);
  };
}

/** Triage counter carried by the classification menu's Uncategorized option.
 *  Hidden rows are left out on purpose: uncategorized *and* noise-filtered is
 *  clutter, and a count on a filter must promise what picking it delivers. */
export interface ActivityUncategorizedSummary {
  entities: number;
  seconds: number;
}

/** How many pending rows the Library's Unclassified section lists at once.
 *  A cap rather than a scroll: the section is a place to make five decisions,
 *  and the rest arrive as those are made. */
export const TRIAGE_VISIBLE = 5;

/** One item of pending classification work. Deliberately thinner than an entity
 *  summary — the section shows an identity, a kind, a total and a control, and
 *  carrying the rest would invite it to grow back into a second catalog. */
export interface ActivityTriageItem {
  id: string;
  kind: ActivityEntityKind;
  /** The pattern an exact rule would be written against. */
  key: string;
  displayName: string;
  /** All-history time. Equal to the uncategorized total, since these rows are
   *  uncategorized in full. */
  seconds: number;
}

export interface ActivityTriage {
  /** The busiest pending items, longest first, capped at TRIAGE_VISIBLE. */
  items: ActivityTriageItem[];
  /** Every pending item, not only the listed ones. */
  total: number;
  seconds: number;
}

export interface ActivityQueryResult {
  catalog: ActivityEntityPage;
  /** Entities the noise policy hides from the catalog, whether or not
   *  includeNoise is currently showing them. Zero while searching. */
  noiseHidden: number;
  /**
   * Windows whose stored title contains the search text, one row per distinct
   * normalized full title. Null when nothing is being searched, because stored
   * titles are never listed until someone asks for them.
   *
   * Matching identities are not carried alongside: a search narrows `catalog`
   * in place, and `catalog` mixes apps and websites exactly as the unsearched
   * list does. Splitting them back into two tables under a search only
   * duplicated a distinction every row already states on its own metadata line
   * and the type filter already controls.
   */
  windowMatches: ActivityTitleGroupPage | null;
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
  /** Pending classification work over all of history. Answers to none of the
   *  query's filters — see triageSummary for why each one is refused. */
  triage: ActivityTriage;
  selectedEntity: ActivityEntitySummary | null;
  /** The selected entity's windows, grouped the same way as a title search.
   *  One entity, so titles alone separate the groups. */
  detailGroups: ActivityTitleGroupPage;
  detailTotal: number;
  /** When the selected entity was used across the range. Deliberately blind to
   *  the window filter: typing in it narrows which windows are listed, not
   *  when the app itself was open. Empty when nothing is selected. */
  selectedEntityUsage: ActivityDayBucket[];
  /** The same, for the one window being inspected. Empty when none is. */
  selectedWindowUsage: ActivityDayBucket[];
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
  /** Earliest visit for each normalized Window identity in all history. */
  lifetimeWindowFirstSeen: Map<string, number>;
  hasStoredTitles: boolean;
  /** Rules that won at least one session in all of history. A rule missing here
   *  is the one actionable usage signal left: nothing matches it, so it is a
   *  deletion candidate. Per-rule detail lives in the entity panel instead. */
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
  forEachLocalDay(startSec, endSec, (day) => target.add(day.key));
}

/** The local calendar day a date falls on, as a comparable integer. */
function dayKeyOf(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Walks the local calendar days a span covers, reporting how much of the span
 * fell on each. Stepping with setDate keeps the walk correct across DST, where
 * a day is not 86400 seconds long — which is also why the seconds are measured
 * from the real day boundaries rather than assumed.
 */
function forEachLocalDay(
  startSec: number,
  endSec: number,
  visit: (day: { key: number; startSec: number; seconds: number }) => void,
): void {
  const cursor = new Date(startSec * 1000);
  cursor.setHours(0, 0, 0, 0);
  // Strictly less than: a session ending exactly at midnight touched the next
  // day for no time at all.
  while (cursor.getTime() / 1000 < endSec) {
    const dayStartSec = cursor.getTime() / 1000;
    const key = dayKeyOf(cursor);
    cursor.setDate(cursor.getDate() + 1);
    const dayEndSec = cursor.getTime() / 1000;
    const from = Math.max(startSec, dayStartSec);
    const to = Math.min(endSec, dayEndSec);
    visit({ key, startSec: dayStartSec, seconds: Math.max(0, to - from) });
  }
}

/**
 * Lays a set of spans out across the query range's calendar days.
 *
 * The range decides the columns, not the spans: an entity used twice in a
 * month should draw two marks in a month-wide strip, not two adjacent bars
 * that imply constant use. Sessions crossing midnight are split, so an
 * overnight run is drawn on both days it happened on.
 */
export function bucketDailyUsage(
  spans: { start: number; end: number }[],
  rangeStartSec: number,
  rangeEndSec: number,
  columns = USAGE_STRIP_COLUMNS,
): ActivityDayBucket[] {
  if (rangeEndSec <= rangeStartSec || columns < 1) return [];
  const dayStarts: number[] = [];
  const columnByDay = new Map<number, number>();
  const cursor = new Date(rangeStartSec * 1000);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() / 1000 < rangeEndSec) {
    columnByDay.set(dayKeyOf(cursor), dayStarts.length);
    dayStarts.push(cursor.getTime() / 1000);
    cursor.setDate(cursor.getDate() + 1);
  }
  if (dayStarts.length === 0) return [];

  const perColumn = Math.ceil(dayStarts.length / columns);
  const buckets: ActivityDayBucket[] = [];
  for (let day = 0; day < dayStarts.length; day += perColumn) {
    const beyond = Math.min(day + perColumn, dayStarts.length);
    buckets.push({
      startSec: dayStarts[day],
      endSec: beyond < dayStarts.length ? dayStarts[beyond] : rangeEndSec,
      days: beyond - day,
      seconds: 0,
    });
  }
  for (const span of spans) {
    forEachLocalDay(span.start, span.end, (day) => {
      const at = columnByDay.get(day.key);
      if (at !== undefined) buckets[Math.floor(at / perColumn)].seconds += day.seconds;
    });
  }
  return buckets;
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
  const lifetimeWindowFirstSeen = new Map<string, number>();
  for (const session of indexed) {
    if (!normalizeWindowTitle(session.title)) continue;
    const key = titleGroupKey(session);
    lifetimeWindowFirstSeen.set(
      key,
      Math.min(lifetimeWindowFirstSeen.get(key) ?? Number.POSITIVE_INFINITY, session.start),
    );
  }
  const index: ActivityIndex = {
    sessions: indexed,
    categories: source.categories,
    rules: source.rules,
    exactRuleByEntity,
    lifetimeEntities: new Map(),
    lifetimeWindowFirstSeen,
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
  // Both states the interface calls "Mixed": time split across categories, and
  // time only partly categorized at all. The filter has to answer for the word
  // it shares with the label, or picking Mixed would hide rows marked Mixed.
  if (filter === "mixed") return entity.status === "mixed" || entity.status === "partial";
  if (filter === "ignored") return entity.status === "ignored";
  const categoryId = Number(filter.slice("category:".length));
  return entity.categories.some((category) => category.categoryId === categoryId);
}

function matchesTitleGroupClassification(
  group: ActivityTitleGroup,
  filter: ActivityClassificationFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "uncategorized") return group.hasUncategorized;
  // As with identities, several ignored categories are still Ignored rather
  // than Mixed; exclusion from Insights is the more important state.
  if (filter === "mixed") return group.mixed && !group.allIgnored;
  if (filter === "ignored") return group.allIgnored;
  const categoryId = Number(filter.slice("category:".length));
  return group.categoryIds.includes(categoryId);
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

/**
 * Pending classification work, and the four things it deliberately ignores.
 *
 * *The range.* Read from lifetime summaries, not the visible ones: a backlog
 * that shrank because the date picker moved would be a to-do list nobody could
 * finish, and "I have classified everything" has to be a statement about the
 * data rather than about a week of it.
 *
 * *Partly-classified rows.* Narrower than the "Uncategorized" filter, which
 * also admits `partial` entities. Those carry stray uncategorized sessions that
 * one assignment cannot clear, so they would stay put after being acted on —
 * worse in a list whose whole promise is that acting on a row removes it.
 *
 * *The search and type filters.* They scope the catalog below, which answers a
 * different question. This section sits above them for that reason.
 *
 * *"Show".* The noise fold applies whatever the catalog is currently showing.
 * Every folded item is uncategorized by construction — classifyNoise returns
 * null for anything already decided — so honouring "Show" would not widen this
 * list at its edges, it would flood it with installers and one-off launches
 * ranked by the same time that ranks real work.
 */
function triageSummary(index: ActivityIndex, policy: NoisePolicy | undefined): ActivityTriage {
  const pending = [...index.lifetimeEntities.values()].filter(
    (entity) =>
      entity.status === "uncategorized"
      && (!policy || classifyNoise(entity, policy) === null),
  );
  return {
    // Longest first: the section is triage, so it spends its five rows on the
    // decisions that move the most time. Name and id only break ties, to keep
    // the order stable across the re-sort every assignment causes.
    items: [...pending]
      .sort((left, right) =>
        right.seconds - left.seconds
        || left.displayName.localeCompare(right.displayName)
        || left.id.localeCompare(right.id))
      .slice(0, TRIAGE_VISIBLE)
      .map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        key: entity.key,
        displayName: entity.displayName,
        seconds: entity.seconds,
      })),
    total: pending.length,
    seconds: pending.reduce((total, entity) => total + entity.seconds, 0),
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
  // rescale the rows already on screen. A title search extends the same scale
  // with every matching Window below.
  let maxSeconds = identityMatches.reduce((most, entity) => Math.max(most, entity.seconds), 0);

  const catalog = {
    rows: page(identityMatches, query.entityOffset, query.entityLimit),
    total: identityMatches.length,
    apps: identityMatches.filter((entity) => entity.kind === "app").length,
    websites: identityMatches.filter((entity) => entity.kind === "website").length,
  };

  // A title has no kind of its own, but every grouped Window has a parent
  // identity that does. Classification is different: it belongs to each visit,
  // so it must be evaluated after grouping rather than inherited from a parent
  // identity that may contain unrelated categories.
  let windowMatches: ActivityTitleGroupPage | null = null;
  if (search) {
    const matching: ActivitySessionRow[] = [];
    for (const session of index.sessions) {
      if (!session.title.toLowerCase().includes(search)) continue;
      const entity = entitiesById.get(session.entityId);
      if (
        !entity
        || !inType(entity)
      ) continue;
      const clipped = clippedSession(session, query.startSec, query.endSec);
      if (clipped) matching.push(clipped);
    }
    matching.sort((left, right) => right.start - left.start || right.id - left.id);
    const grouped = groupSessionsByTitle(matching)
      .filter((group) => matchesTitleGroupClassification(group, query.classificationFilter));
    for (const group of grouped) {
      const lifetimeFirstSeen = index.lifetimeWindowFirstSeen.get(group.key) ?? group.firstSeen;
      group.isNew = canBeNew && lifetimeFirstSeen >= query.startSec;
      maxSeconds = Math.max(maxSeconds, group.seconds);
    }
    grouped.sort(compareTitleGroups(query.windowSort, query.windowDirection));
    // The page limit counts titles, not sessions: one busy window should cost
    // one row here, which is the entire point of grouping.
    windowMatches = {
      rows: page(grouped, query.windowOffset, query.windowLimit),
      total: grouped.length,
      sessionTotal: grouped.reduce((total, group) => total + group.sessionCount, 0),
      maxSeconds: grouped.reduce((most, group) => Math.max(most, group.seconds), 0),
    };
  }

  const selectedEntity = query.selectedEntityId
    ? (entitiesById.get(query.selectedEntityId) ?? null)
    : null;
  const detailSearch = query.detailSearch?.trim().toLowerCase() ?? "";
  // Collected before the filter is applied, so the usage strip below can
  // describe the entity while the list beside it describes the filter.
  const entityRows: ActivitySessionRow[] = [];
  if (selectedEntity) {
    for (const session of index.sessions) {
      if (session.entityId !== selectedEntity.id) continue;
      const clipped = clippedSession(session, query.startSec, query.endSec);
      if (clipped) entityRows.push(clipped);
    }
    entityRows.sort((left, right) => right.start - left.start || right.id - left.id);
  }
  const selectedEntityUsage = selectedEntity
    ? bucketDailyUsage(entityRows, query.startSec, query.endSec)
    : [];
  const detailRows = detailSearch
    ? entityRows.filter((session) => session.title.toLowerCase().includes(detailSearch))
    : entityRows;
  // Titles are no longer blanked until searched. That rule tied a privacy
  // decision to an unrelated control — one character in the detail search
  // revealed everything anyway — and it cannot coexist with grouping, which
  // has nothing to name its groups by if the titles are empty. The panel
  // offers an explicit toggle instead, and title capture is still opt-in and
  // off by default, which is where the real consent lives.
  const detailGrouped = groupSessionsByTitle(detailRows);
  for (const group of detailGrouped) {
    const lifetimeFirstSeen = index.lifetimeWindowFirstSeen.get(group.key) ?? group.firstSeen;
    group.isNew = canBeNew && lifetimeFirstSeen >= query.startSec;
  }
  detailGrouped.sort(compareTitleGroups(
    query.detailSort ?? "seconds",
    query.detailDirection ?? "desc",
  ));
  // GROUP_SESSION_SAMPLE keeps the payload sane across hundreds of groups, but
  // it also decided that a visit older than the newest twenty-five could not be
  // ticked, corrected, or deleted on its own — only as part of "all visits".
  // One group at a time is cheap, so the one being inspected pages properly.
  let selectedWindowUsage: ActivityDayBucket[] = [];
  if (query.selectedWindowKey) {
    const inspected = detailGrouped.find((group) => group.key === query.selectedWindowKey);
    if (inspected) {
      const visits = detailRows.filter(
        (session) => titleGroupKey(session) === query.selectedWindowKey,
      );
      inspected.sessions = visits.slice(
        0,
        query.selectedWindowSessionLimit ?? GROUP_SESSION_SAMPLE,
      );
      // Every visit, not the page of them carried for the list: a strip drawn
      // from the first twenty-five would redraw itself on "load more".
      selectedWindowUsage = bucketDailyUsage(visits, query.startSec, query.endSec);
    }
  }

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
    triage: triageSummary(index, policy),
    selectedEntity,
    detailGroups: {
      rows: page(detailGrouped, query.detailOffset ?? 0, query.detailLimit ?? 50),
      total: detailGrouped.length,
      sessionTotal: detailRows.length,
      maxSeconds: detailGrouped.reduce((most, group) => Math.max(most, group.seconds), 0),
    },
    selectedEntityUsage,
    selectedWindowUsage,
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
