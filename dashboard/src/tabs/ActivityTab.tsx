import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button, Card, CategoryDot, Spinner, TrashButton } from "../components/ui";
import { withAlias } from "../lib/aliases";
import {
  type ActivityClassificationFilter,
  type ActivityEntitySummary,
  type ActivityQuery,
  type ActivityQueryResult,
  type ActivityRuleUsage,
  type ActivitySessionRow,
  type ActivitySort,
  type ActivitySortDirection,
  type ActivitySource,
  type ActivityTypeFilter,
} from "../lib/activity";
import {
  categoryState,
  categoryStateFlags,
  type Category,
  type CategoryState,
  type MatchType,
} from "../lib/classify";
import { UNCATEGORIZED } from "../lib/chartTheme";
import { browserDomainCoverage, shouldShowDomainCoverageHint } from "../lib/domainCoverage";
import { fmtDuration } from "../lib/format";
import { clipSessions } from "../lib/metrics";
import {
  addCategory,
  addRule,
  backupDatabase,
  deleteActivity,
  deleteCategory,
  deleteRule,
  previewActivityDelete,
  saveProcessAliases,
  updateCategory,
  type ActivityDeletePreview,
  type ActivityDeleteRequest,
} from "../lib/queries";
import { allTimeRange, type Range } from "../lib/time";
import { useBanner } from "../state/banner";
import { useActivityModel } from "../state/useActivityModel";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

type ActivityView = "library" | "rules";

const CATEGORY_SWATCHES = [
  "#9c8ff0",
  "#2f6fc0",
  "#56c8d8",
  "#43c88a",
  "#1d9e75",
  "#e0a53a",
  "#e8663d",
  "#e75fa0",
  "#b08a5e",
  "#828994",
];

const STATE_COLORS: Record<CategoryState, string> = {
  productive: "#4fb389",
  neutral: "#9aa0a8",
  unproductive: "#d07d7d",
  ignored: "#5b616b",
};

const RULE_LABELS: Record<MatchType, string> = {
  domain: "Website",
  title: "Window",
  process: "App",
};

const RULE_HELP: Record<MatchType, string> = {
  domain: "Matches a site such as github.com. Page paths and searches are not stored.",
  title: "Matches words in a stored browser window title.",
  process: "Matches the foreground executable, such as code.exe.",
};

function formatDateTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ActivityTab({
  range,
  firstSessionSec,
  historyRevision,
  isAllTime,
  onTryAllTime,
}: {
  range: Range;
  firstSessionSec: number | null;
  historyRevision: number;
  isAllTime: boolean;
  onTryAllTime: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [view, setView] = useState<ActivityView>("library");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>("all");
  const [classificationFilter, setClassificationFilter] =
    useState<ActivityClassificationFilter>("all");
  const [sort, setSort] = useState<ActivitySort>("seconds");
  const [direction, setDirection] = useState<ActivitySortDirection>("desc");
  const [entityLimit, setEntityLimit] = useState(100);
  const [windowLimit, setWindowLimit] = useState(50);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [detailSearch, setDetailSearch] = useState("");
  const [detailLimit, setDetailLimit] = useState(50);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<number>>(() => new Set());
  const [deleteScope, setDeleteScope] = useState<{ request: ActivityDeleteRequest; label: string } | null>(null);

  const allRange = useMemo(() => allTimeRange(firstSessionSec), [firstSessionSec, historyRevision]);
  const sessionData = useSessions(
    allRange.start.getTime() / 1000,
    allRange.end.getTime() / 1000,
    historyRevision,
  );
  const browserProcesses = useMemo(() => [...meta.browserSet].sort(), [meta.browserSet]);
  const source = useMemo<ActivitySource | null>(() => {
    if (!sessionData.ready) return null;
    return {
      sessions: sessionData.sessions,
      categories: meta.categories,
      rules: meta.rules,
      browserProcesses,
      aliases: meta.aliases,
    };
  }, [sessionData.ready, sessionData.sessions, meta.categories, meta.rules, meta.aliases, browserProcesses]);

  const query = useMemo<ActivityQuery>(() => ({
    startSec: range.start.getTime() / 1000,
    endSec: range.end.getTime() / 1000,
    search: deferredSearch,
    typeFilter,
    classificationFilter,
    sort,
    direction,
    entityOffset: 0,
    entityLimit,
    windowOffset: 0,
    windowLimit,
    selectedEntityId,
    detailSearch,
    detailOffset: 0,
    detailLimit,
  }), [
    range.start,
    range.end,
    deferredSearch,
    typeFilter,
    classificationFilter,
    sort,
    direction,
    entityLimit,
    windowLimit,
    selectedEntityId,
    detailSearch,
    detailLimit,
  ]);
  const analyzed = useActivityModel(source, query);
  const result = analyzed.result;

  useEffect(() => {
    setEntityLimit(100);
    setWindowLimit(50);
    setSelectedSessionIds(new Set());
  }, [deferredSearch, typeFilter, classificationFilter, range.start, range.end]);

  useEffect(() => {
    if (!classificationFilter.startsWith("category:")) return;
    const categoryId = Number(classificationFilter.slice("category:".length));
    if (!meta.categories.some((category) => category.id === categoryId)) {
      setClassificationFilter("all");
    }
  }, [classificationFilter, meta.categories]);

  useEffect(() => {
    setDetailSearch("");
    setDetailLimit(50);
    setSelectedSessionIds(new Set());
  }, [selectedEntityId]);

  useEffect(() => {
    setDetailLimit(50);
    setSelectedSessionIds(new Set());
  }, [detailSearch]);

  const showDomainHint = useMemo(() => {
    if (!sessionData.ready) return false;
    const clipped = clipSessions(
      sessionData.sessions,
      range.start.getTime() / 1000,
      range.end.getTime() / 1000,
    ).filter((session) => !session.isAfk);
    return shouldShowDomainCoverageHint(browserDomainCoverage(clipped, meta.browserSet));
  }, [sessionData.ready, sessionData.sessions, range.start, range.end, meta.browserSet]);

  const refreshMeta = async () => {
    await meta.refresh();
  };
  const assignEntity = async (entity: ActivityEntitySummary, categoryId: number) => {
    try {
      const matchType = entity.kind === "website" ? "domain" : "process";
      const exactRules = meta.rules.filter(
        (rule) => rule.matchType === matchType && rule.pattern.toLowerCase() === entity.key.toLowerCase(),
      );
      const retained = exactRules.find((rule) => rule.categoryId === categoryId);
      for (const rule of exactRules) {
        if (rule.id !== retained?.id) await deleteRule(rule.id);
      }
      if (!retained) await addRule(matchType, entity.key, categoryId);
      await refreshMeta();
    } catch (error) {
      banner.report(error, "classification");
    }
  };
  const saveAlias = async (key: string, alias: string) => {
    const next = withAlias(meta.aliases, key, alias);
    try {
      await saveProcessAliases(next);
      await refreshMeta();
    } catch (error) {
      banner.report(error, "name");
    }
  };
  const removeExactRules = async (entity: ActivityEntitySummary) => {
    try {
      const matchType = entity.kind === "website" ? "domain" : "process";
      const exactRules = meta.rules.filter(
        (rule) => rule.matchType === matchType && rule.pattern.toLowerCase() === entity.key.toLowerCase(),
      );
      for (const rule of exactRules) await deleteRule(rule.id);
      await refreshMeta();
    } catch (error) {
      banner.report(error, "rule");
    }
  };
  const toggleSession = (id: number) => setSelectedSessionIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const requestSelectedDeletion = () => {
    if (selectedSessionIds.size === 0) return;
    setDeleteScope({
      request: { mode: "sessions", sessionIds: [...selectedSessionIds] },
      label: `${selectedSessionIds.size} selected session${selectedSessionIds.size === 1 ? "" : "s"}`,
    });
  };
  const requestEntityDeletion = (entity: ActivityEntitySummary) => {
    setDeleteScope({
      request: {
        mode: "entity",
        entityKind: entity.kind,
        entityKey: entity.key,
        startSec: range.start.getTime() / 1000,
        endSec: range.end.getTime() / 1000,
        browserProcesses,
      },
      label: `${entity.kind === "website" ? "Website" : "App"} “${entity.displayName}” (${entity.key}) from ${formatShortDate(range.start.getTime() / 1000)} through ${formatShortDate((range.end.getTime() - 1) / 1000)}`,
    });
  };
  const historyDeleted = (closeEntity: boolean) => {
    setSelectedSessionIds(new Set());
    if (closeEntity) setSelectedEntityId(null);
  };

  if (!meta.loaded || (!result && (sessionData.loading || analyzed.refreshing))) return <Spinner />;
  const error = sessionData.error ?? analyzed.error;
  if (error && !result) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  return (
    <div className="relative flex flex-col gap-4" aria-busy={analyzed.refreshing || sessionData.refreshing}>
      <div className="flex items-center justify-between">
        <div className="flex rounded-[10px] border border-edge bg-surface p-1">
          <ViewButton active={view === "library"} onClick={() => setView("library")}>Activity Library</ViewButton>
          <ViewButton active={view === "rules"} onClick={() => setView("rules")}>Categories & Rules</ViewButton>
        </div>
        {(analyzed.refreshing || sessionData.refreshing) && result && (
          <span className="text-[10.5px] text-ink-3">Updating…</span>
        )}
      </div>

      {view === "library" ? (
        <>
          {showDomainHint && (
            <section className="rounded-[12px] border border-accent/20 bg-accent/[.045] px-4 py-3 text-[11.5px] text-ink-2">
              Browser time is not being split by website. Install the third-party &quot;URL in title&quot;
              extension so Time can read websites from browser window titles.
            </section>
          )}
          {result && (result.currentAttention.entities > 0 || result.allHistoryAttention.entities > 0) && (
            <NeedsAttention
              result={result}
              categories={meta.categories}
              onAssign={assignEntity}
              onShowAll={() => {
                setSearch("");
                setTypeFilter("all");
                setClassificationFilter("needs_attention");
              }}
              onTryAllTime={onTryAllTime}
              isAllTime={isAllTime}
            />
          )}
          <Card
            title="Activity Library"
            right={result ? <span className="text-[11px] text-ink-3">{result.catalog.total} items in range</span> : undefined}
          >
            <LibraryControls
              search={search}
              onSearch={setSearch}
              typeFilter={typeFilter}
              onTypeFilter={setTypeFilter}
              classificationFilter={classificationFilter}
              onClassificationFilter={setClassificationFilter}
              categories={meta.categories}
            />
            {result && (
              deferredSearch.trim() && result.searchResults ? (
                <GroupedSearchResults
                  result={result}
                  sort={sort}
                  direction={direction}
                  onSort={(next) => updateSort(next, sort, direction, setSort, setDirection)}
                  selectedEntityId={selectedEntityId}
                  onSelectEntity={setSelectedEntityId}
                  selectedSessionIds={selectedSessionIds}
                  onToggleSession={toggleSession}
                  onDeleteSelected={requestSelectedDeletion}
                  canLoadEntities={
                    result.searchResults.apps.total > result.searchResults.apps.rows.length ||
                    result.searchResults.websites.total > result.searchResults.websites.rows.length
                  }
                  onLoadEntities={() => setEntityLimit((limit) => limit + 100)}
                  canLoadWindows={result.searchResults.windowTotal > result.searchResults.windowMatches.length}
                  onLoadWindows={() => setWindowLimit((limit) => limit + 50)}
                  isAllTime={isAllTime}
                  onTryAllTime={onTryAllTime}
                />
              ) : (
                <EntityCatalog
                  page={result.catalog}
                  sort={sort}
                  direction={direction}
                  onSort={(next) => updateSort(next, sort, direction, setSort, setDirection)}
                  selectedEntityId={selectedEntityId}
                  onSelect={setSelectedEntityId}
                  onLoadMore={() => setEntityLimit((limit) => limit + 100)}
                  isAllTime={isAllTime}
                  onTryAllTime={onTryAllTime}
                />
              )
            )}
          </Card>
        </>
      ) : (
        <CategoriesAndRules
          ruleUsage={result?.ruleUsage ?? []}
          categoryUsage={result?.categoryUsage ?? []}
          onChanged={refreshMeta}
        />
      )}

      {result?.selectedEntity && (
        <EntityDrawer
          entity={result.selectedEntity}
          sessions={result.detailSessions}
          sessionTotal={result.detailTotal}
          hasStoredTitles={result.hasStoredTitles}
          detailSearch={detailSearch}
          onDetailSearch={setDetailSearch}
          onLoadMore={() => setDetailLimit((limit) => limit + 50)}
          onClose={() => setSelectedEntityId(null)}
          categories={meta.categories}
          aliases={meta.aliases}
          selectedSessionIds={selectedSessionIds}
          onToggleSession={toggleSession}
          onDeleteSelected={requestSelectedDeletion}
          onDeleteEntity={() => requestEntityDeletion(result.selectedEntity!)}
          onAssign={(categoryId) => assignEntity(result.selectedEntity!, categoryId)}
          onSaveAlias={(alias) => saveAlias(result.selectedEntity!.key, alias)}
          onRemoveExactRule={() => removeExactRules(result.selectedEntity!)}
        />
      )}

      {deleteScope && (
        <DeleteActivityDialog
          scope={deleteScope}
          onClose={() => setDeleteScope(null)}
          onDeleted={(request) => {
            setDeleteScope(null);
            historyDeleted(request.mode === "entity");
          }}
        />
      )}
    </div>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[7px] px-3 py-1.5 text-xs transition-colors ${active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"}`}
    >
      {children}
    </button>
  );
}

function LibraryControls({
  search,
  onSearch,
  typeFilter,
  onTypeFilter,
  classificationFilter,
  onClassificationFilter,
  categories,
}: {
  search: string;
  onSearch: (value: string) => void;
  typeFilter: ActivityTypeFilter;
  onTypeFilter: (value: ActivityTypeFilter) => void;
  classificationFilter: ActivityClassificationFilter;
  onClassificationFilter: (value: ActivityClassificationFilter) => void;
  categories: Category[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-edge/50 pb-4">
      <label className="relative min-w-[240px] flex-1">
        <span className="sr-only">Search activity</span>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="absolute left-3 top-2.5 h-3.5 w-3.5 text-ink-3">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
        </svg>
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search apps, websites, and windows…"
          className="w-full rounded-[9px] border border-edge bg-surface-2 py-2 pl-9 pr-3 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
        />
      </label>
      <select
        aria-label="Activity type"
        value={typeFilter}
        onChange={(event) => onTypeFilter(event.target.value as ActivityTypeFilter)}
        className="rounded-[9px] border border-edge bg-surface-2 px-2.5 py-2 text-xs outline-none focus:border-accent/60"
      >
        <option value="all">All types</option>
        <option value="app">Apps</option>
        <option value="website">Websites</option>
      </select>
      <select
        aria-label="Classification filter"
        value={classificationFilter}
        onChange={(event) => onClassificationFilter(event.target.value as ActivityClassificationFilter)}
        className="rounded-[9px] border border-edge bg-surface-2 px-2.5 py-2 text-xs outline-none focus:border-accent/60"
      >
        <option value="all">All classifications</option>
        <option value="needs_attention">Needs attention</option>
        <option value="mixed">Mixed</option>
        <option value="ignored">Ignored</option>
        {categories.filter((category) => !category.isIgnored).map((category) => (
          <option key={category.id} value={`category:${category.id}`}>{category.name}</option>
        ))}
      </select>
    </div>
  );
}

function NeedsAttention({
  result,
  categories,
  onAssign,
  onShowAll,
  onTryAllTime,
  isAllTime,
}: {
  result: ActivityQueryResult;
  categories: Category[];
  onAssign: (entity: ActivityEntitySummary, categoryId: number) => Promise<void>;
  onShowAll: () => void;
  onTryAllTime: () => void;
  isAllTime: boolean;
}) {
  return (
    <section className="rounded-[14px] border border-edge bg-surface px-4 py-3.5">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-ink-2" />
        <span className="text-[13px] font-semibold">Needs attention</span>
        <span className="text-[11px] text-ink-3">
          {result.currentAttention.entities} items · {fmtDuration(result.currentAttention.seconds)} uncategorized
        </span>
        <span className="flex-1" />
        {!isAllTime && result.allHistoryAttention.entities > result.currentAttention.entities && (
          <button type="button" onClick={onTryAllTime} className="text-[11px] text-ink-3 hover:text-ink-2">
            {result.allHistoryAttention.entities} across all history
          </button>
        )}
        {result.needsAttentionTotal > result.needsAttention.length && (
          <button type="button" onClick={onShowAll} className="text-[11px] text-accent hover:text-accent/80">Show all</button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {result.needsAttention.map((entity) => (
          <span key={entity.id} className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 px-3 py-2 text-xs">
            <span className="max-w-40 truncate">{entity.displayName}</span>
            <span className="text-[10.5px] text-ink-3">{fmtDuration(entity.uncategorizedSeconds)}</span>
            <select
              aria-label={`Categorize ${entity.displayName}`}
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) void onAssign(entity, Number(event.target.value));
                event.currentTarget.value = "";
              }}
              className="rounded-md border border-edge bg-surface px-1.5 py-1 text-[10.5px] text-ink-2 outline-none focus:border-accent/60"
            >
              <option value="">Assign…</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </span>
        ))}
      </div>
    </section>
  );
}

function updateSort(
  next: ActivitySort,
  current: ActivitySort,
  direction: ActivitySortDirection,
  setSort: (sort: ActivitySort) => void,
  setDirection: (direction: ActivitySortDirection) => void,
): void {
  if (next === current) setDirection(direction === "asc" ? "desc" : "asc");
  else {
    setSort(next);
    setDirection(next === "name" ? "asc" : "desc");
  }
}

function SortHeading({
  label,
  field,
  active,
  direction,
  className = "",
  onSort,
}: {
  label: string;
  field: ActivitySort;
  active: boolean;
  direction: ActivitySortDirection;
  className?: string;
  onSort: (field: ActivitySort) => void;
}) {
  return (
    <th className={`pb-2 font-medium ${className}`}>
      <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-ink-2">
        {label}{active && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

function EntityCatalog({
  page,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelect,
  onLoadMore,
  isAllTime,
  onTryAllTime,
}: {
  page: { rows: ActivityEntitySummary[]; total: number };
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  isAllTime: boolean;
  onTryAllTime: () => void;
}) {
  if (page.total === 0) return <NoResults isAllTime={isAllTime} onTryAllTime={onTryAllTime} />;
  return (
    <>
      <EntityTable
        rows={page.rows}
        sort={sort}
        direction={direction}
        onSort={onSort}
        selectedEntityId={selectedEntityId}
        onSelect={onSelect}
      />
      {page.rows.length < page.total && <LoadMore shown={page.rows.length} total={page.total} onClick={onLoadMore} />}
    </>
  );
}

function GroupedSearchResults({
  result,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelectEntity,
  selectedSessionIds,
  onToggleSession,
  onDeleteSelected,
  canLoadEntities,
  onLoadEntities,
  canLoadWindows,
  onLoadWindows,
  isAllTime,
  onTryAllTime,
}: {
  result: ActivityQueryResult;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelectEntity: (id: string) => void;
  selectedSessionIds: Set<number>;
  onToggleSession: (id: number) => void;
  onDeleteSelected: () => void;
  canLoadEntities: boolean;
  onLoadEntities: () => void;
  canLoadWindows: boolean;
  onLoadWindows: () => void;
  isAllTime: boolean;
  onTryAllTime: () => void;
}) {
  const groups = result.searchResults!;
  const total = groups.apps.total + groups.websites.total + groups.windowTotal;
  if (total === 0) return <NoResults isAllTime={isAllTime} onTryAllTime={onTryAllTime} />;
  return (
    <div className="flex flex-col gap-5">
      {groups.apps.total > 0 && (
        <ResultGroup title="Apps" count={groups.apps.total}>
          <EntityTable rows={groups.apps.rows} sort={sort} direction={direction} onSort={onSort} selectedEntityId={selectedEntityId} onSelect={onSelectEntity} />
        </ResultGroup>
      )}
      {groups.websites.total > 0 && (
        <ResultGroup title="Websites" count={groups.websites.total}>
          <EntityTable rows={groups.websites.rows} sort={sort} direction={direction} onSort={onSort} selectedEntityId={selectedEntityId} onSelect={onSelectEntity} />
        </ResultGroup>
      )}
      {canLoadEntities && <LoadMore shown={groups.apps.rows.length + groups.websites.rows.length} total={groups.apps.total + groups.websites.total} onClick={onLoadEntities} />}
      {groups.windowTotal > 0 && (
        <ResultGroup title="Window matches" count={groups.windowTotal}>
          <SessionTable rows={groups.windowMatches} selected={selectedSessionIds} onToggle={onToggleSession} />
          {selectedSessionIds.size > 0 && (
            <div className="mt-3 flex justify-end"><Button variant="danger" onClick={onDeleteSelected}>Delete selected…</Button></div>
          )}
          {canLoadWindows && <LoadMore shown={groups.windowMatches.length} total={groups.windowTotal} onClick={onLoadWindows} />}
        </ResultGroup>
      )}
    </div>
  );
}

function ResultGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[.04em] text-ink-3">
        <span>{title}</span><span>· {count}</span>
      </div>
      {children}
    </section>
  );
}

function EntityTable({
  rows,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelect,
}: {
  rows: ActivityEntitySummary[];
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] table-fixed text-xs">
        <thead>
          <tr className="border-b border-edge text-left text-[10.5px] uppercase tracking-[.04em] text-ink-3">
            <SortHeading label="Name" field="name" active={sort === "name"} direction={direction} onSort={onSort} className="w-[32%] text-left" />
            <th className="w-[28%] pb-2 font-medium">Classification</th>
            <SortHeading label="Time" field="seconds" active={sort === "seconds"} direction={direction} onSort={onSort} className="w-[13%] text-right" />
            <SortHeading label="Last seen" field="lastSeen" active={sort === "lastSeen"} direction={direction} onSort={onSort} className="w-[17%] text-right" />
            <SortHeading label="Sessions" field="sessions" active={sort === "sessions"} direction={direction} onSort={onSort} className="w-[10%] text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((entity) => (
            <tr
              key={entity.id}
              className={`cursor-pointer border-b border-edge/40 transition-colors hover:bg-white/[.018] ${selectedEntityId === entity.id ? "bg-white/[.025]" : ""}`}
              tabIndex={0}
              onClick={() => onSelect(entity.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(entity.id);
                }
              }}
            >
              <td className="py-2.5 pr-4">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate" title={entity.key}>{entity.displayName}</span>
                  <span className="text-[10px] capitalize leading-none text-ink-3">{entity.kind}</span>
                </span>
              </td>
              <td className="py-2.5 pr-4"><ClassificationLabel entity={entity} /></td>
              <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(entity.seconds)}</td>
              <td className="py-2.5 text-right tabular-nums text-ink-3">{formatShortDate(entity.lastSeen)}</td>
              <td className="py-2.5 text-right tabular-nums text-ink-3">{entity.sessionCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassificationLabel({ entity }: { entity: ActivityEntitySummary }) {
  if (entity.status === "uncategorized") {
    return <span className="flex items-center gap-2 text-ink-3"><CategoryDot color={UNCATEGORIZED} />Uncategorized</span>;
  }
  if (entity.status === "partial") {
    return (
      <span className="flex items-center gap-2 text-ink-2" title={`${fmtDuration(entity.uncategorizedSeconds)} remains uncategorized`}>
        <CategoryDot color={UNCATEGORIZED} />Partially categorized
      </span>
    );
  }
  if (entity.status === "mixed") {
    return (
      <span className="flex flex-col gap-1 text-ink-2">
        <span className="flex items-center gap-2">
          <span className="flex h-1.5 w-14 overflow-hidden rounded-full bg-surface-3" aria-label="Category distribution">
            {entity.categories.map((category) => (
              <span
                key={category.categoryId}
                title={`${category.name}: ${fmtDuration(category.seconds)}`}
                style={{ width: `${(category.seconds / entity.seconds) * 100}%`, backgroundColor: category.color }}
              />
            ))}
          </span>
          Mixed
        </span>
        <span className="text-[9.5px] leading-tight text-ink-3">This item is categorized differently across its sessions.</span>
      </span>
    );
  }
  const category = entity.categories[0];
  return (
    <span className="flex items-center gap-2 text-ink-2">
      <CategoryDot color={category?.color ?? UNCATEGORIZED} />
      {entity.status === "ignored" ? "Ignored · Excluded from Insights" : (category?.name ?? "Uncategorized")}
    </span>
  );
}

function SessionTable({ rows, selected, onToggle }: { rows: ActivitySessionRow[]; selected: Set<number>; onToggle: (id: number) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] table-fixed text-xs">
        <thead>
          <tr className="border-b border-edge text-left text-[10.5px] uppercase tracking-[.04em] text-ink-3">
            <th className="w-9 pb-2"><span className="sr-only">Select</span></th>
            <th className="w-[20%] pb-2 font-medium">When</th>
            <th className="w-[18%] pb-2 font-medium">App / Website</th>
            <th className="w-[32%] pb-2 font-medium">Window</th>
            <th className="w-[20%] pb-2 font-medium">Classification</th>
            <th className="w-[10%] pb-2 text-right font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((session) => (
            <tr key={session.id} className="border-b border-edge/40">
              <td className="py-2.5"><input type="checkbox" checked={selected.has(session.id)} onChange={() => onToggle(session.id)} aria-label={`Select session ${formatDateTime(session.start)}`} /></td>
              <td className="py-2.5 pr-3 tabular-nums text-ink-3">{formatDateTime(session.start)}</td>
              <td className="truncate py-2.5 pr-3" title={session.entityKey}>{session.displayName}</td>
              <td className="truncate py-2.5 pr-3 text-ink-2" title={session.title}>{session.title || "—"}</td>
              <td className="py-2.5 pr-3 text-ink-2">
                <span className="flex items-center gap-2">
                  <CategoryDot color={session.categoryColor ?? UNCATEGORIZED} />
                  <span className="min-w-0"><span className="block truncate">{session.categoryName ?? "Uncategorized"}</span><span className="block truncate text-[10px] text-ink-3">{session.winningRulePattern ? `${RULE_LABELS[session.winningRuleType!]} · ${session.winningRulePattern}` : "No matching rule"}</span></span>
                </span>
              </td>
              <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(session.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoResults({ isAllTime, onTryAllTime }: { isAllTime: boolean; onTryAllTime: () => void }) {
  return (
    <div className="flex h-36 flex-col items-center justify-center gap-2 text-sm text-ink-3">
      <span>No activity found in this range</span>
      {!isAllTime && <button type="button" onClick={onTryAllTime} className="text-xs text-accent hover:text-accent/80">Try All time</button>}
    </div>
  );
}

function LoadMore({ shown, total, onClick }: { shown: number; total: number; onClick: () => void }) {
  return (
    <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-ink-3">
      <span>{shown} of {total}</span>
      <button type="button" onClick={onClick} className="rounded-md px-2 py-1 text-accent hover:bg-accent/10">Load more</button>
    </div>
  );
}

function EntityDrawer({
  entity,
  sessions,
  sessionTotal,
  hasStoredTitles,
  detailSearch,
  onDetailSearch,
  onLoadMore,
  onClose,
  categories,
  aliases,
  selectedSessionIds,
  onToggleSession,
  onDeleteSelected,
  onDeleteEntity,
  onAssign,
  onSaveAlias,
  onRemoveExactRule,
}: {
  entity: ActivityEntitySummary;
  sessions: ActivitySessionRow[];
  sessionTotal: number;
  hasStoredTitles: boolean;
  detailSearch: string;
  onDetailSearch: (value: string) => void;
  onLoadMore: () => void;
  onClose: () => void;
  categories: Category[];
  aliases: Record<string, string>;
  selectedSessionIds: Set<number>;
  onToggleSession: (id: number) => void;
  onDeleteSelected: () => void;
  onDeleteEntity: () => void;
  onAssign: (categoryId: number) => Promise<void>;
  onSaveAlias: (alias: string) => Promise<void>;
  onRemoveExactRule: () => Promise<void>;
}) {
  const savedAlias = aliases[entity.key.toLowerCase()] ?? "";
  const [aliasDraft, setAliasDraft] = useState(savedAlias);
  const cancelAlias = useRef(false);
  useEffect(() => setAliasDraft(savedAlias), [savedAlias, entity.key]);
  const commitAlias = () => {
    if (cancelAlias.current) {
      cancelAlias.current = false;
      setAliasDraft(savedAlias);
    } else if (aliasDraft.trim() !== savedAlias) {
      void onSaveAlias(aliasDraft);
    }
  };
  return (
    <>
      <button type="button" aria-label="Close activity details" className="fixed inset-0 z-40 bg-black/25 max-md:hidden" onClick={onClose} />
      <aside className="fixed bottom-0 right-0 top-0 z-50 flex w-[min(620px,92vw)] flex-col border-l border-edge bg-surface shadow-[-18px_0_48px_rgba(0,0,0,.4)] max-md:static max-md:z-auto max-md:w-full max-md:border-l-0 max-md:border-t max-md:shadow-none">
        <div className="flex items-start gap-3 border-b border-edge px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] uppercase tracking-[.05em] text-ink-3">{entity.kind}</p>
            <h2 className="truncate text-lg font-semibold">{entity.displayName}</h2>
            <p className="truncate font-mono text-[11px] text-ink-3" title={entity.key}>{entity.key}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-ink-3 hover:bg-surface-3 hover:text-ink">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DetailMetric label="Time in range" value={fmtDuration(entity.seconds)} />
            <DetailMetric label="Sessions" value={String(entity.sessionCount)} />
            <DetailMetric label="First seen" value={formatShortDate(entity.firstSeen)} />
            <DetailMetric label="Last seen" value={formatShortDate(entity.lastSeen)} />
          </div>
          <section className="mt-5">
            <h3 className="text-xs font-semibold">Display name</h3>
            <input value={aliasDraft} placeholder={entity.displayName} onFocus={() => { cancelAlias.current = false; }} onChange={(event) => setAliasDraft(event.target.value)} onBlur={commitAlias} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); else if (event.key === "Escape") { cancelAlias.current = true; event.currentTarget.blur(); } }} className="mt-2 w-full rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-xs outline-none focus:border-accent/60" />
            <p className="mt-1.5 text-[10.5px] text-ink-3">Enter or click away to save. Leave blank to use the recorded name.</p>
          </section>
          <section className="mt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold">Classification</h3>
              <select defaultValue="" aria-label={entity.kind === "website" ? "Set website category" : "Set app default"} onChange={(event) => { if (event.target.value) void onAssign(Number(event.target.value)); event.currentTarget.value = ""; }} className="rounded-lg border border-edge bg-surface-2 px-2 py-1.5 text-[11px] outline-none focus:border-accent/60">
                <option value="">{entity.kind === "website" ? "Set website category…" : "Set app default…"}</option>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </div>
            {entity.status === "mixed" && <p className="mt-2 text-[11px] text-ink-3">This item is categorized differently across its sessions. Website and Window rules can override an App default.</p>}
            <div className="mt-3 flex flex-col gap-2">
              {entity.categories.map((category) => (
                <div key={category.categoryId} className="flex items-center gap-2 text-[11.5px]"><CategoryDot color={category.color} /><span className="flex-1">{category.name}</span><span className="tabular-nums text-ink-3">{fmtDuration(category.seconds)}</span></div>
              ))}
              {entity.uncategorizedSeconds > 0 && <div className="flex items-center gap-2 text-[11.5px]"><CategoryDot color={UNCATEGORIZED} /><span className="flex-1">Uncategorized</span><span className="tabular-nums text-ink-3">{fmtDuration(entity.uncategorizedSeconds)}</span></div>}
            </div>
            {entity.rules.length > 0 && (
              <div className="mt-4 rounded-lg border border-edge/70 bg-surface-2 px-3 py-2.5">
                <p className="mb-2 text-[10.5px] font-medium text-ink-2">Rules in use</p>
                <div className="flex flex-col gap-2">
                  {entity.rules.map((rule) => (
                    <div key={rule.ruleId} className="flex items-center gap-2 text-[10.5px]">
                      <span className="w-14 shrink-0 text-ink-3">{RULE_LABELS[rule.matchType]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>{rule.pattern}</span>
                      <CategoryDot color={rule.categoryColor} />
                      <span className="truncate text-ink-2">{rule.categoryName}</span>
                      <span className="shrink-0 tabular-nums text-ink-3">{rule.sessions} · {fmtDuration(rule.seconds)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="mt-3 text-[10.5px] leading-snug text-ink-3">Classification changes apply to all matching historical and future activity, not only this date range.</p>
            {entity.exactRuleId !== null && <button type="button" onClick={() => void onRemoveExactRule()} className="mt-2 text-[11px] text-bad hover:text-bad/80">Remove exact {entity.kind === "website" ? "Website" : "App"} rule</button>}
          </section>
          <section className="mt-5">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold">Sessions</h3>
              <span className="text-[10.5px] text-ink-3">{sessionTotal}</span>
              <span className="flex-1" />
              {selectedSessionIds.size > 0 && <Button variant="danger" onClick={onDeleteSelected}>Delete selected…</Button>}
            </div>
            {hasStoredTitles && <input value={detailSearch} onChange={(event) => onDetailSearch(event.target.value)} placeholder="Filter windows…" className="mt-3 w-full rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60" />}
            <div className="mt-3 flex flex-col gap-1.5">
              {sessions.map((session) => (
                <label key={session.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-edge/60 px-2.5 py-2 text-[11px] hover:bg-white/[.018]">
                  <input type="checkbox" checked={selectedSessionIds.has(session.id)} onChange={() => onToggleSession(session.id)} className="mt-0.5" />
                  <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="text-ink-2">{formatDateTime(session.start)}</span><span className="text-ink-3">{fmtDuration(session.seconds)}</span></span>{session.title && <span className="mt-0.5 block truncate text-ink-3" title={session.title}>{session.title}</span>}<span className="mt-0.5 flex items-center gap-1.5 text-ink-3"><CategoryDot color={session.categoryColor ?? UNCATEGORIZED} />{session.categoryName ?? "Uncategorized"}{session.winningRuleType && ` · ${RULE_LABELS[session.winningRuleType]} rule`}</span></span>
                </label>
              ))}
              {sessions.length === 0 && <p className="py-5 text-center text-[11px] text-ink-3">No sessions match this filter.</p>}
            </div>
            {sessions.length < sessionTotal && <LoadMore shown={sessions.length} total={sessionTotal} onClick={onLoadMore} />}
          </section>
        </div>
        <div className="flex items-center justify-between border-t border-edge px-5 py-4">
          <p className="max-w-72 text-[10.5px] leading-snug text-ink-3">Deletes complete session rows overlapping the visible range. Categories, rules, and aliases are kept.</p>
          <Button variant="danger" onClick={onDeleteEntity}>Delete activity in range…</Button>
        </div>
      </aside>
    </>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-edge bg-surface-2 p-3"><p className="text-[10px] text-ink-3">{label}</p><p className="mt-1 text-sm font-semibold tabular-nums">{value}</p></div>;
}

function DeleteActivityDialog({
  scope,
  onClose,
  onDeleted,
}: {
  scope: { request: ActivityDeleteRequest; label: string };
  onClose: () => void;
  onDeleted: (request: ActivityDeleteRequest) => void;
}) {
  const banner = useBanner();
  const [preview, setPreview] = useState<ActivityDeletePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void previewActivityDelete(scope.request).then(
      (value) => { if (!cancelled) { setPreview(value); setLoading(false); } },
      (error) => { if (!cancelled) { setLoading(false); banner.report(error, "deletion preview"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [scope]);
  const confirm = async () => {
    if (!preview || preview.count === 0) return;
    setDeleting(true);
    try {
      const request = {
        ...scope.request,
        snapshotMaxId: preview.snapshotMaxId,
        previewProtectedSessionId: preview.protectedSessionId,
      } as ActivityDeleteRequest & { snapshotMaxId: number };
      const result = await deleteActivity(request);
      if (result.protectedCount > 0) {
        banner.show(`${result.protectedCount} current live session was kept. Pause recording and retry after it closes if you need to remove it.`);
      }
      onDeleted(scope.request);
    } catch (error) {
      banner.report(error, "activity deletion");
      setDeleting(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-5">
      <div role="dialog" aria-modal="true" aria-labelledby="delete-activity-title" className="w-full max-w-md rounded-[14px] border border-edge-2 bg-surface p-5 shadow-2xl">
        <h2 id="delete-activity-title" className="text-sm font-semibold">Delete recorded activity?</h2>
        {loading || !preview ? <div className="py-8"><Spinner label="Checking deletion scope…" /></div> : (
          <>
            <p className="mt-3 text-xs text-ink-2">{scope.label}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <DetailMetric label="Sessions" value={String(preview.count)} />
              <DetailMetric label="Recorded time" value={fmtDuration(preview.seconds)} />
            </div>
            {preview.earliestStart !== null && preview.latestEnd !== null && <p className="mt-3 text-[11px] text-ink-3">{formatDateTime(preview.earliestStart)} through {formatDateTime(preview.latestEnd)}</p>}
            <p className="mt-3 text-[11px] leading-snug text-ink-3">Complete session rows are removed, securely compacted, and cannot be restored unless you made a backup.</p>
            {preview.protectedCount > 0 && <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px] text-ink-2">{preview.protectedCount} current live session is protected. Pause recording and retry after it closes if you need to remove it.</p>}
            {preview.count === 0 && <p className="mt-3 text-[11px] text-ink-3">There are no deletable sessions in this scope.</p>}
            {backupPath && <p className="mt-3 break-all text-[10.5px] text-ink-3">Backup saved to {backupPath}</p>}
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button onClick={() => void backupDatabase().then(setBackupPath).catch((error) => banner.report(error, "backup"))}>Back up first</Button>
              <Button variant="danger" disabled={preview.count === 0 || deleting} onClick={() => void confirm()}>{deleting ? "Deleting…" : "Delete"}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CategoriesAndRules({
  ruleUsage,
  categoryUsage,
  onChanged,
}: {
  ruleUsage: ActivityRuleUsage[];
  categoryUsage: Array<{ categoryId: number; sessions: number; seconds: number; lastUsed: number }>;
  onChanged: () => Promise<void>;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set<number>());
  const [stateMenu, setStateMenu] = useState<number | null>(null);
  const [colorMenu, setColorMenu] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<number, { type: MatchType; pattern: string }>>({});
  const usageByRule = new Map(ruleUsage.map((usage) => [usage.ruleId, usage]));
  const usageByCategory = new Map(categoryUsage.map((usage) => [usage.categoryId, usage]));

  const draftFor = (id: number) => drafts[id] ?? { type: "domain" as const, pattern: "" };
  const setDraft = (id: number, patch: Partial<{ type: MatchType; pattern: string }>) =>
    setDrafts((current) => ({ ...current, [id]: { ...draftFor(id), ...patch } }));
  const toggle = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const submitRule = async (categoryId: number) => {
    const draft = draftFor(categoryId);
    if (!draft.pattern.trim()) return;
    try {
      await addRule(draft.type, draft.pattern, categoryId);
      setDraft(categoryId, { pattern: "" });
      await onChanged();
    } catch (error) {
      banner.report(error, "rule");
    }
  };
  const submitCategory = async () => {
    if (!newName.trim()) return;
    const used = new Set(meta.categories.map((category) => category.color.toLowerCase()));
    const color = CATEGORY_SWATCHES.find((swatch) => !used.has(swatch)) ?? CATEGORY_SWATCHES[meta.categories.length % CATEGORY_SWATCHES.length];
    try {
      const id = await addCategory(newName, color, "unproductive");
      setNewName("");
      setExpanded((current) => new Set(current).add(id));
      await onChanged();
    } catch (error) {
      banner.report(error, "category");
    }
  };
  const setCategoryState = async (category: Category, option: CategoryState) => {
    try { await updateCategory({ ...category, ...categoryStateFlags(option) }); await onChanged(); }
    catch (error) { banner.report(error, "category"); }
  };
  const setCategoryColor = async (category: Category, color: string) => {
    try { await updateCategory({ ...category, color }); await onChanged(); }
    catch (error) { banner.report(error, "category"); }
  };
  const saveRename = async (category: Category) => {
    const name = renameDraft.trim();
    setRenaming(null);
    if (!name || name === category.name) return;
    try { await updateCategory({ ...category, name }); await onChanged(); }
    catch (error) { banner.report(error, "category"); }
  };
  const removeRule = async (ruleId: number) => {
    try { await deleteRule(ruleId); await onChanged(); }
    catch (error) { banner.report(error, "rule"); }
  };
  const removeCategory = async (category: Category, ruleCount: number) => {
    const ruleText = ruleCount ? ` and ${ruleCount} ${ruleCount === 1 ? "rule" : "rules"}` : "";
    if (!window.confirm(`Delete “${category.name}”${ruleText}? This cannot be undone.`)) return;
    try {
      await deleteCategory(category.id);
      setExpanded((current) => { const next = new Set(current); next.delete(category.id); return next; });
      await onChanged();
    } catch (error) { banner.report(error, "category"); }
  };

  return (
    <Card title="Categories & Rules" right={<span className="text-[11px] text-ink-3">{meta.categories.length} categories · {meta.rules.length} rules</span>}>
      {(stateMenu !== null || colorMenu !== null) && <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => { setStateMenu(null); setColorMenu(null); }} />}
      <p className="mb-1 text-[11px] text-ink-3">Rules classify all matching historical and future activity.</p>
      <p className="mb-4 text-[11px] text-ink-3">When several rules match, Website wins, then Window, then App.</p>
      <div className="flex flex-col gap-2">
        {meta.categories.map((category) => {
          const open = expanded.has(category.id);
          const state = categoryState(category);
          const rules = meta.rules.filter((rule) => rule.categoryId === category.id);
          const draft = draftFor(category.id);
          const categoryStats = usageByCategory.get(category.id);
          return (
            <div key={category.id} className={`rounded-[11px] border border-edge bg-surface-2 ${stateMenu === category.id || colorMenu === category.id ? "overflow-visible" : "overflow-hidden"}`}>
              <div className="flex items-center gap-2.5 px-3 py-3 text-xs">
                <button type="button" aria-expanded={open} aria-controls={`category-rules-${category.id}`} aria-label={`${open ? "Collapse" : "Expand"} ${category.name} rules`} onClick={() => toggle(category.id)} className="flex h-6 w-6 items-center justify-center rounded-md text-[10px] text-ink-3 hover:bg-surface-3 hover:text-ink-2"><span className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}>▶</span></button>
                <span className="relative">
                  <button type="button" title="Change color" aria-label={`Change color of ${category.name}`} className="block h-3 w-3 rounded hover:shadow-[0_0_0_2px_var(--color-edge-2)]" style={{ backgroundColor: category.color }} onClick={() => { setColorMenu(colorMenu === category.id ? null : category.id); setStateMenu(null); }} />
                  {colorMenu === category.id && <span className="menu-pop absolute left-0 top-[calc(100%+6px)] z-50 grid w-[136px] grid-cols-5 gap-2 rounded-[11px] border border-edge-2 bg-surface-2 p-2.5 shadow-[0_12px_34px_rgba(0,0,0,.5)]">{CATEGORY_SWATCHES.map((swatch) => <button key={swatch} type="button" aria-label={`Use color ${swatch}`} className={`h-4 w-4 rounded hover:shadow-[0_0_0_2px_var(--color-ink-3)] ${swatch === category.color.toLowerCase() ? "shadow-[0_0_0_2px_var(--color-ink-2)]" : ""}`} style={{ backgroundColor: swatch }} onClick={() => { setColorMenu(null); void setCategoryColor(category, swatch); }} />)}</span>}
                </span>
                {renaming === category.id ? <input autoFocus value={renameDraft} aria-label={`Rename ${category.name}`} onChange={(event) => setRenameDraft(event.target.value)} onBlur={() => void saveRename(category)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(category); else if (event.key === "Escape") setRenaming(null); }} className="w-44 rounded-md border border-edge bg-surface px-1.5 py-0.5 text-xs font-semibold outline-none focus:border-accent/60" /> : <span className="font-semibold">{category.name}</span>}
                <button type="button" disabled={category.isIgnored} title={category.isIgnored ? "The built-in Ignored category cannot be renamed" : `Rename ${category.name}`} aria-label={category.isIgnored ? "Ignored cannot be renamed" : `Rename ${category.name}`} onClick={() => { setRenaming(category.id); setRenameDraft(category.name); }} className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink-2 disabled:cursor-not-allowed disabled:opacity-35"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m4 20 4.2-1 10.7-10.7a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z" /><path d="m14.7 6.9 2.8 2.8" /></svg></button>
                <span className="ml-1 text-[10.5px] text-ink-3">{categoryStats ? `${fmtDuration(categoryStats.seconds)} · ${categoryStats.sessions} sessions` : "No applied activity"}</span>
                <span className="flex-1" />
                <span className="relative w-[112px] shrink-0">
                  <button type="button" className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] capitalize text-ink-3 hover:bg-surface-3" onClick={() => { setStateMenu(stateMenu === category.id ? null : category.id); setColorMenu(null); }}><CategoryDot color={STATE_COLORS[state]} />{state}</button>
                  {stateMenu === category.id && <span className="menu-pop absolute right-0 top-[calc(100%+5px)] z-50 min-w-[155px] rounded-[11px] border border-edge-2 bg-surface-2 p-1 shadow-[0_12px_34px_rgba(0,0,0,.5)]">{(["productive", "neutral", "unproductive", "ignored"] as CategoryState[]).map((option) => <button type="button" key={option} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] capitalize hover:bg-surface-3 ${option === state ? "bg-surface-3" : ""}`} onClick={() => { setStateMenu(null); void setCategoryState(category, option); }}><CategoryDot color={STATE_COLORS[option]} /><span className="flex-1">{option}</span>{option === state && <span className="text-accent">✓</span>}</button>)}</span>}
                </span>
                <span className="w-[64px] text-right text-[10.5px] text-ink-3">{rules.length} {rules.length === 1 ? "rule" : "rules"}</span>
              </div>
              {open && (
                <div id={`category-rules-${category.id}`} className="ml-[46px] border-t border-edge/50 px-3 py-3">
                  <div className="flex flex-col gap-1.5">
                    {rules.map((rule) => {
                      const usage = usageByRule.get(rule.id);
                      return <div key={rule.id} className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1 text-[11.5px] hover:bg-white/[.028]"><span className="w-[70px] shrink-0 rounded-md bg-surface-3 px-1.5 py-1 text-center text-[9.5px] uppercase text-ink-2">{RULE_LABELS[rule.matchType]}</span><span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>{rule.pattern}</span><span className="shrink-0 text-[10.5px] text-ink-3">{usage ? `${usage.sessions} applied · ${fmtDuration(usage.seconds)} · last ${formatShortDate(usage.lastUsed)}` : "No applied activity"}</span><TrashButton compact label={`Delete ${RULE_LABELS[rule.matchType]} rule ${rule.pattern}`} onClick={() => void removeRule(rule.id)} /></div>;
                    })}
                    {rules.length === 0 && <p className="py-1 text-[11px] italic text-ink-3">No rules yet — add one below.</p>}
                  </div>
                  <div className="mt-3 border-t border-edge/40 pt-3">
                    <div className="flex items-center gap-2">
                      <span className="flex rounded-lg border border-edge bg-surface p-0.5">{(["domain", "title", "process"] as MatchType[]).map((type) => <button key={type} type="button" className={`rounded-md px-2 py-1 text-[10.5px] ${draft.type === type ? "bg-surface-3 text-ink-2" : "text-ink-3 hover:text-ink-2"}`} onClick={() => setDraft(category.id, { type })}>{RULE_LABELS[type]}</button>)}</span>
                      <input value={draft.pattern} onChange={(event) => setDraft(category.id, { pattern: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void submitRule(category.id); }} placeholder={draft.type === "domain" ? "example.com" : draft.type === "title" ? "words to match…" : "example.exe"} className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-ink-3 focus:border-accent/60" />
                      <Button variant="primary" disabled={!draft.pattern.trim()} onClick={() => void submitRule(category.id)}>Add rule</Button>
                    </div>
                    <p className="mt-2 text-[10.5px] text-ink-3">
                      {RULE_HELP[draft.type]}
                      {draft.type === "domain" && " Website rules require a supported browser and detected website information."}
                      {draft.type === "title" && (meta.settings.record_window_titles === "1"
                        ? " Window title capture is enabled."
                        : " Future window title capture is off; existing stored titles can still match.")}
                    </p>
                  </div>
                  <div className="mt-3 flex justify-end border-t border-edge/40 pt-3"><TrashButton label={category.isIgnored ? "The built-in Ignored category cannot be deleted" : `Delete ${category.name}`} disabled={category.isIgnored} onClick={() => void removeCategory(category, rules.length)} /></div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-edge/50 pt-4"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitCategory(); }} placeholder="New category name" className="w-56 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60" /><Button variant="primary" disabled={!newName.trim()} onClick={() => void submitCategory()}>+ Add category</Button></div>
    </Card>
  );
}
