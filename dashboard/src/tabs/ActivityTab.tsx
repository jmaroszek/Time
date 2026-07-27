import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  Button,
  Card,
  CategoryDot,
  Checkbox,
  MenuSelect,
  RemoveButton,
  Spinner,
  type MenuOption,
} from "../components/ui";
import { withAlias } from "../lib/aliases";
import {
  type ActivityClassificationFilter,
  type ActivityEntityPage,
  type ActivityEntitySummary,
  type ActivityQuery,
  type ActivityQueryResult,
  type ActivityTitleGroup,
  type ActivityTitleGroupPage,
  type ActivitySort,
  type ActivitySortDirection,
  type ActivitySource,
  type ActivityTypeFilter,
} from "../lib/activity";
import { buildActivityExport, type ActivityExportKind } from "../lib/activityExport";
import {
  ANY_APP,
  BROWSER_SCOPE,
  buildClassifier,
  categoryState,
  categoryStateFlags,
  type Category,
  type CategoryState,
  type MatchType,
  type Productivity,
  type Rule,
} from "../lib/classify";
import { UNCATEGORIZED } from "../lib/chartTheme";
import type { Palette } from "../lib/palettes";
import { browserDomainCoverage, shouldShowDomainCoverageHint } from "../lib/domainCoverage";
import { fmtDuration } from "../lib/format";
import { clipSessions } from "../lib/metrics";
import {
  addCategory,
  addRule,
  addTrackingExclusion,
  backupDatabase,
  correctSession,
  deleteActivity,
  deleteCategory,
  deleteRule,
  fetchSessionCorrection,
  listTrackingExclusions,
  previewActivityDelete,
  previewTrackingExclusion,
  removeTrackingExclusion,
  resetSessionCorrection,
  saveActivityExport,
  saveProcessAliases,
  updateCategory,
  type ActivityDeletePreview,
  type ActivityDeleteRequest,
  type SessionCorrection,
  type TrackingExclusion,
  type TrackingExclusionKind,
} from "../lib/queries";
import { allTimeRange, type Range } from "../lib/time";
import { useBanner } from "../state/banner";
import { useActivityModel } from "../state/useActivityModel";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

type ActivityView = "library" | "rules";

/** "Excluded" is a view of the pre-capture exclusion list, not a property of a
 *  recorded entity — the classification dropdown is only its entry point. */
type LibraryFilter = ActivityClassificationFilter | "excluded";

/** One palette for productivity everywhere it names a state: the chart bars and
 *  these classification chips share the selected palette's fills. Ignored keeps
 *  its own gray — it is an absence of judgment, not one of the three states. */
function stateColors(palette: Palette): Record<CategoryState, string> {
  return {
    productive: palette.productive,
    neutral: palette.neutral,
    unproductive: palette.unproductive,
    ignored: "#5b616b",
  };
}

/** The three productivity states a category can be given. Ignoring is not among
 *  them: the built-in Ignored category is the one ignore mechanism, so the flag
 *  is no longer something an ordinary category can be put into. */
const ASSIGNABLE_STATES: Productivity[] = ["productive", "neutral", "unproductive"];

const RULE_LABELS: Record<MatchType, string> = {
  domain: "Website",
  title: "Window",
  process: "App",
};

const RULE_HELP: Record<MatchType, string> = {
  domain: "Matches a site such as github.com. Page paths and searches are not stored.",
  title: "Matches words in a stored window title, in whichever apps its scope allows.",
  process: "Matches the foreground executable, such as code.exe.",
};

/** Rule kinds are told apart by shape, not hue: color in this app means
 *  category identity, so a colored chip per kind would overload it. */
function RuleKindGlyph({ matchType }: { matchType: MatchType }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {matchType === "process" && <rect x="4" y="4" width="16" height="16" rx="3" />}
      {matchType === "title" && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>}
      {matchType === "domain" && <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z" /></>}
    </svg>
  );
}

/** The built-in Ignored row, told apart from a category a previous release let
 *  the user flag ignored. Names are unique, and an ignored category could never
 *  be renamed, so the seeded name still identifies it. Legacy flagged
 *  categories stay editable so they have a way back out of that state. */
function isBuiltInIgnored(category: Category): boolean {
  return category.isIgnored && category.name === "Ignored";
}

/** Small pages keep the scroll well shallow: "load more" should deepen it a
 *  little, not add a screen of rows at a time. */
const ENTITY_PAGE = 50;
const WINDOW_PAGE = 50;

type Setter<T> = (update: (current: T) => T) => void;

/** Five swatches to a row, so the grid's width is fixed and can be used to keep
 *  the menu on screen when a category sits near the right edge. */
const SWATCH_MENU_WIDTH = 136;

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

/** Whole days between two instants by local calendar date, so "yesterday"
 *  means the previous date rather than 24 hours ago. */
function calendarDaysAgo(then: Date, now: Date): number {
  const thenMidnight = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((nowMidnight.getTime() - thenMidnight.getTime()) / 86_400_000);
}

/** A date is the least useful rendering of the most recent activity: for
 *  anything touched today the time of day is the answer, and for yesterday
 *  the word beats working the date out. Older than that, the date wins again. */
export function formatLastSeen(seconds: number, now = new Date()): string {
  const seen = new Date(seconds * 1000);
  const days = calendarDaysAgo(seen, now);
  if (days <= 0) {
    return `Today, ${seen.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  if (days === 1) return "Yesterday";
  return formatShortDate(seconds);
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
  const [classificationFilter, setClassificationFilter] = useState<LibraryFilter>("all");
  const [sort, setSort] = useState<ActivitySort>("seconds");
  const [direction, setDirection] = useState<ActivitySortDirection>("desc");
  const [includeNoise, setIncludeNoise] = useState(false);
  const [entityLimit, setEntityLimit] = useState(ENTITY_PAGE);
  const [windowLimit, setWindowLimit] = useState(WINDOW_PAGE);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [detailSearch, setDetailSearch] = useState("");
  const [detailLimit, setDetailLimit] = useState(50);
  // Two surfaces tick sessions — the window-match table and the drawer's
  // session list — and they get a set each. Sharing one meant the drawer's
  // "clear on a different entity" rule reached across and wiped a search
  // selection the moment a result row was clicked, which is one stray click
  // away from a list of fifty ticks.
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<number>>(() => new Set());
  const [drawerSessionIds, setDrawerSessionIds] = useState<Set<number>>(() => new Set());
  const [deleteScope, setDeleteScope] = useState<{ request: ActivityDeleteRequest; label: string } | null>(null);
  const [excludeScope, setExcludeScope] = useState<{
    kind: TrackingExclusionKind;
    pattern: string;
    label: string;
  } | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [ruleDraft, setRuleDraft] = useState<ActivityTitleGroup | null>(null);
  // Off means the drawer lists windows without naming them, for anyone sharing
  // a screen. Titles are opt-in and off by default at capture, which is where
  // the real consent lives; this is only about what is on screen right now.
  const [showTitles, setShowTitles] = useState(true);

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
    classificationFilter: classificationFilter === "excluded" ? "all" : classificationFilter,
    sort,
    direction,
    noise: meta.noisePolicy,
    includeNoise,
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
    meta.noisePolicy,
    includeNoise,
    entityLimit,
    windowLimit,
    selectedEntityId,
    detailSearch,
    detailLimit,
  ]);
  const analyzed = useActivityModel(source, query);
  const result = analyzed.result;

  useEffect(() => {
    setEntityLimit(ENTITY_PAGE);
    setWindowLimit(WINDOW_PAGE);
    setSelectedSessionIds(new Set());
  }, [deferredSearch, typeFilter, classificationFilter, range.start, range.end]);

  useEffect(() => {
    if (!classificationFilter.startsWith("category:")) return;
    const categoryId = Number(classificationFilter.slice("category:".length));
    if (!meta.categories.some((category) => category.id === categoryId)) {
      setClassificationFilter("all");
    }
  }, [classificationFilter, meta.categories]);

  // Only the drawer's own ticks are cleared here. A selection is about rows a
  // reader can see, and opening a different entity replaces every row in the
  // drawer — but none of the ones in the list behind it.
  useEffect(() => {
    setDetailSearch("");
    setDetailLimit(50);
    setDrawerSessionIds(new Set());
  }, [selectedEntityId]);

  useEffect(() => {
    setDetailLimit(50);
    setDrawerSessionIds(new Set());
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
  const toggle = (set: Setter<Set<number>>) => (id: number) => set((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSession = toggle(setSelectedSessionIds);
  const toggleDrawerSession = toggle(setDrawerSessionIds);
  /** Scoped to the rows actually on screen, never the unloaded remainder: the
   *  only honest promise a checkbox can make is about what it can be seen to
   *  tick, and deletion here is exact by design. A window group is on screen as
   *  one row, so ticking it takes every visit it stands for. */
  const toggleAll = (set: Setter<Set<number>>) => (ids: number[]) => set((current) => {
    const next = new Set(current);
    if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
    else for (const id of ids) next.add(id);
    return next;
  });
  const toggleAllSessions = toggleAll(setSelectedSessionIds);
  const toggleAllDrawerSessions = toggleAll(setDrawerSessionIds);
  const requestSessionDeletion = (ids: Set<number>) => {
    if (ids.size === 0) return;
    setDeleteScope({
      request: { mode: "sessions", sessionIds: [...ids] },
      label: `${ids.size} selected session${ids.size === 1 ? "" : "s"}`,
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
    // Both sets, whichever surface asked: the rows behind either are gone.
    setSelectedSessionIds(new Set());
    setDrawerSessionIds(new Set());
    if (closeEntity) setSelectedEntityId(null);
  };

  if (!meta.loaded || (!result && (sessionData.loading || analyzed.refreshing))) return <Spinner />;
  const error = sessionData.error ?? analyzed.error;
  if (error && !result) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const showingExclusions = classificationFilter === "excluded";
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-4"
      aria-busy={analyzed.refreshing || sessionData.refreshing}
    >
      {view === "library" && showDomainHint && (
        <section className="shrink-0 rounded-[12px] border border-accent/20 bg-accent/[.045] px-4 py-3 text-[11.5px] text-ink-2">
          Browser time is not being split by website. Install the third-party &quot;URL in title&quot;
          extension so Time can read websites from browser window titles.
        </section>
      )}

      {/* One card, whose title is the switcher: a floating control row above it
          left the page reading as two stacked chromes instead of "date picker
          up top, one card below". */}
      {/* Only the Library fills the window. Categories & Rules is a short,
          mostly-folded list, and stretching it to the viewport bought a screen
          of empty card for nothing. It still takes min-h-0, so it sizes to its
          content while staying able to shrink — enough categories opened at
          once then scrolls the card instead of the page. */}
      <Card
        className={`flex min-h-0 flex-col ${view === "library" ? "flex-1" : ""}`}
        title={<ViewSwitcher view={view} onView={setView} />}
        right={view === "library" ? (
          <span className="flex items-center gap-3 text-[11px] text-ink-3">
            {/* Muted, not accent: this is about rows nobody asked to see, and
                it was the loudest thing in the header while being the least
                consequential. The row count it used to sit beside is gone —
                the load-more footer already reports it, and only to someone
                who has scrolled far enough to be asking. */}
            {result && !showingExclusions && result.noiseHidden > 0 && (
              <button
                type="button"
                onClick={() => setIncludeNoise((shown) => !shown)}
                className="underline-offset-2 hover:text-ink-2 hover:underline"
                title="Rare-item and utility rows are hidden from this list. They still count in every total."
              >
                {includeNoise
                  ? `Hide ${result.noiseHidden} filtered`
                  : `${result.noiseHidden} filtered · Show`}
              </button>
            )}
            {source && result && (
              <ActivityExportMenu
                source={source}
                range={range}
                hasStoredTitles={result.hasStoredTitles}
              />
            )}
          </span>
        ) : (
          <span className="text-[11px] text-ink-3">{meta.categories.length} categories · {meta.rules.length} rules</span>
        )}
      >
        {view === "library" ? (
          <>
            <LibraryControls
              search={search}
              onSearch={setSearch}
              typeFilter={typeFilter}
              onTypeFilter={setTypeFilter}
              classificationFilter={classificationFilter}
              onClassificationFilter={setClassificationFilter}
              categories={meta.categories}
              uncategorizedCount={result?.uncategorized.entities ?? 0}
            />
            {showingExclusions ? (
              <ExcludedPanel />
            ) : (
              result && (
                <TableRegion>
                  {result.windowMatches ? (
                    <SearchResults
                      identities={result.catalog}
                      windows={result.windowMatches}
                      search={deferredSearch.trim()}
                      typeFilter={typeFilter}
                      scale={result}
                      sort={sort}
                      direction={direction}
                      onSort={(next) => updateSort(next, sort, direction, setSort, setDirection)}
                      selectedEntityId={selectedEntityId}
                      onSelectEntity={setSelectedEntityId}
                      selectedSessionIds={selectedSessionIds}
                      onToggleSession={toggleSession}
                      onToggleAllSessions={toggleAllSessions}
                      onDeleteSelected={() => requestSessionDeletion(selectedSessionIds)}
                      onEditSession={setEditingSessionId}
                      onMakeRule={setRuleDraft}
                      onLoadIdentities={() => setEntityLimit((limit) => limit + ENTITY_PAGE)}
                      onLoadWindows={() => setWindowLimit((limit) => limit + WINDOW_PAGE)}
                      isAllTime={isAllTime}
                      onTryAllTime={onTryAllTime}
                    />
                  ) : (
                    <EntityCatalog
                      page={result.catalog}
                      scale={result}
                      sort={sort}
                      direction={direction}
                      onSort={(next) => updateSort(next, sort, direction, setSort, setDirection)}
                      selectedEntityId={selectedEntityId}
                      onSelect={setSelectedEntityId}
                      onLoadMore={() => setEntityLimit((limit) => limit + ENTITY_PAGE)}
                      isAllTime={isAllTime}
                      onTryAllTime={onTryAllTime}
                    />
                  )}
                </TableRegion>
              )
            )}
          </>
        ) : (
          <CategoriesAndRules appliedRuleIds={result?.appliedRuleIds ?? null} onChanged={refreshMeta} />
        )}
      </Card>

      {result?.selectedEntity && (
        <EntityDrawer
          entity={result.selectedEntity}
          groups={result.detailGroups}
          hasStoredTitles={result.hasStoredTitles}
          detailSearch={detailSearch}
          onDetailSearch={setDetailSearch}
          showTitles={showTitles}
          onShowTitles={setShowTitles}
          onLoadMore={() => setDetailLimit((limit) => limit + 50)}
          onClose={() => setSelectedEntityId(null)}
          categories={meta.categories}
          aliases={meta.aliases}
          selectedSessionIds={drawerSessionIds}
          onToggleSession={toggleDrawerSession}
          onToggleAllSessions={toggleAllDrawerSessions}
          onDeleteSelected={() => requestSessionDeletion(drawerSessionIds)}
          onDeleteEntity={() => requestEntityDeletion(result.selectedEntity!)}
          onExclude={() => setExcludeScope({
            kind: result.selectedEntity!.kind === "app" ? "app" : "website",
            pattern: result.selectedEntity!.key,
            label: result.selectedEntity!.displayName,
          })}
          onEditSession={setEditingSessionId}
          onMakeRule={setRuleDraft}
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
      {excludeScope && (
        <TrackingExclusionDialog
          scope={excludeScope}
          onClose={() => setExcludeScope(null)}
          onAdded={(deletedHistory) => {
            setExcludeScope(null);
            if (deletedHistory) setSelectedEntityId(null);
          }}
        />
      )}
      {ruleDraft && (
        <WindowRuleDialog
          group={ruleDraft}
          categories={meta.categories}
          source={source}
          browserProcesses={browserProcesses}
          onClose={() => setRuleDraft(null)}
          onSaved={() => { setRuleDraft(null); void refreshMeta(); }}
        />
      )}
      {editingSessionId !== null && (
        <SessionCorrectionDialog
          sessionId={editingSessionId}
          categories={meta.categories}
          onClose={() => setEditingSessionId(null)}
        />
      )}
    </div>
  );
}

/** Rendered as the card's title, so the two views read as one card's two faces
 *  rather than a control row floating above it. */
function ViewSwitcher({ view, onView }: { view: ActivityView; onView: (view: ActivityView) => void }) {
  return (
    <span className="flex items-center gap-2.5">
      <ViewButton active={view === "library"} onClick={() => onView("library")}>Activity Library</ViewButton>
      <span aria-hidden="true" className="text-edge-2">|</span>
      <ViewButton active={view === "rules"} onClick={() => onView("rules")}>Categories &amp; Rules</ViewButton>
    </span>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`transition-colors ${active ? "text-ink" : "font-normal text-ink-3 hover:text-ink-2"}`}
    >
      {children}
    </button>
  );
}

/**
 * One bounded well for whatever the Library is showing. Without the bound the
 * card stretches the page every time "load more" is pressed; with it, the
 * footprint is stable and only the well gets deeper.
 *
 * The bound is the leftover viewport height rather than a fraction of it: the
 * well does not start at the top of the screen, so any fixed vh can only be
 * right at one window size — it left a tall monitor with several rows of dead
 * space below the card and squeezed a short one.
 */
function TableRegion({ children }: { children: ReactNode }) {
  // pr-4 is the scrollbar's gutter: the last column is right-aligned, so
  // without it the dates sit against the scrollbar.
  return (
    <div className="scroll-well min-h-[240px] flex-1 overflow-auto pr-4">{children}</div>
  );
}

/**
 * Three kinds of filter share one menu, and the rules mark the seams: how an
 * entity is classified, which category it landed in, and last the two ways an
 * entity sits outside the count — ignored, which is recorded but excluded from
 * Insights, and excluded, which is never recorded at all. The category rule
 * moves to whichever category comes first and disappears with them when none
 * are defined.
 */
function classificationOptions(categories: Category[], uncategorizedCount: number): MenuOption[] {
  const named = categories.filter((category) => !category.isIgnored);
  return [
    { value: "all", label: "All classifications" },
    // The count rides the option that applies the filter rather than sitting
    // in the card header as a second entry point to it: one control, and one
    // that can show whether it is engaged.
    {
      value: "uncategorized",
      label: uncategorizedCount > 0 ? `Uncategorized (${uncategorizedCount})` : "Uncategorized",
    },
    { value: "mixed", label: "Mixed" },
    ...named.map((category, i) => ({
      value: `category:${category.id}`,
      label: category.name,
      divider: i === 0,
    })),
    { value: "ignored", label: "Ignored", divider: true },
    { value: "excluded", label: "Excluded from tracking" },
  ];
}

function LibraryControls({
  search,
  onSearch,
  typeFilter,
  onTypeFilter,
  classificationFilter,
  onClassificationFilter,
  categories,
  uncategorizedCount,
}: {
  search: string;
  onSearch: (value: string) => void;
  typeFilter: ActivityTypeFilter;
  onTypeFilter: (value: ActivityTypeFilter) => void;
  classificationFilter: LibraryFilter;
  onClassificationFilter: (value: LibraryFilter) => void;
  categories: Category[];
  uncategorizedCount: number;
}) {
  // Search and type narrow recorded activity; the excluded list is not
  // recorded activity, so leaving them enabled there would be a lie.
  const searching = classificationFilter !== "excluded";
  return (
    <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/50 pb-4">
      {searching ? (
        <>
          <label className="relative min-w-[240px] flex-1">
            <span className="sr-only">Search activity</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="absolute left-3 top-2.5 h-3.5 w-3.5 text-ink-3">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
            </svg>
            <input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              // Escape clears without reaching for the mouse, the same way it
              // backs out of every menu and dialog in the app.
              onKeyDown={(event) => { if (event.key === "Escape" && search) { event.preventDefault(); onSearch(""); } }}
              placeholder="Search apps, websites, and windows…"
              className="w-full rounded-[9px] border border-edge bg-surface-2 py-2 pl-9 pr-8 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
            />
            {/* Searching swaps the whole list out for something else, so there
                has to be a way back that is not "select the text and delete
                it" — every other state in this tab has one. */}
            {search && (
              <button
                type="button"
                onClick={() => onSearch("")}
                title="Clear search"
                className="absolute right-2 top-1.5 rounded p-1 text-ink-3 hover:bg-white/[.06] hover:text-ink-2"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
                <span className="sr-only">Clear search</span>
              </button>
            )}
          </label>
          <MenuSelect
            size="field"
            variant={typeFilter === "all" ? "resting" : "engaged"}
            label="Activity type"
            value={typeFilter}
            onChange={(value) => onTypeFilter(value as ActivityTypeFilter)}
            options={[
              { value: "all", label: "All types" },
              { value: "app", label: "Apps" },
              { value: "website", label: "Websites" },
            ]}
          />
        </>
      ) : (
        <span className="min-w-[240px] flex-1 text-[11.5px] text-ink-3">
          Apps and websites Time is not allowed to record.
        </span>
      )}
      <MenuSelect
        size="field"
        variant={classificationFilter === "all" ? "resting" : "engaged"}
        label="Classification filter"
        value={classificationFilter}
        onChange={(value) => onClassificationFilter(value as LibraryFilter)}
        options={classificationOptions(categories, uncategorizedCount)}
      />
    </div>
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

/**
 * `offset` is for tables that sit under a sticky group heading: both stick to
 * the same scroll container, so the header row has to start where the heading
 * ends or it lands underneath it.
 */
function StickyHead({ children, offset = "top-0" }: { children: ReactNode; offset?: string }) {
  return (
    <thead className={`sticky z-10 bg-surface shadow-[0_1px_0_var(--color-edge)] ${offset}`}>
      {children}
    </thead>
  );
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
  scale,
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
  scale: BarScale;
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
        scale={scale}
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

/**
 * Two groups, not three. Apps and websites are one table because they are one
 * table everywhere else: the unsearched catalog mixes them, every row already
 * says which it is on its metadata line, and the type filter above is the
 * control for narrowing to one. Splitting them cost a duplicated header row, a
 * second copy of the sort control that silently drove the first, one page limit
 * feeding two lists, and a **Load more** stranded below the table it grew.
 *
 * What remains separate is worth separating: identities are clicked to inspect,
 * sessions are ticked to delete. Different question, different shape, different
 * verb.
 */
function SearchResults({
  identities,
  windows,
  search,
  typeFilter,
  scale,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelectEntity,
  selectedSessionIds,
  onToggleSession,
  onToggleAllSessions,
  onDeleteSelected,
  onEditSession,
  onMakeRule,
  onLoadIdentities,
  onLoadWindows,
  isAllTime,
  onTryAllTime,
}: {
  identities: ActivityEntityPage;
  windows: ActivityTitleGroupPage;
  search: string;
  typeFilter: ActivityTypeFilter;
  scale: BarScale;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelectEntity: (id: string) => void;
  selectedSessionIds: Set<number>;
  onToggleSession: (id: number) => void;
  onToggleAllSessions: (ids: number[]) => void;
  onDeleteSelected: () => void;
  onEditSession: (id: number) => void;
  onMakeRule: (group: ActivityTitleGroup) => void;
  onLoadIdentities: () => void;
  onLoadWindows: () => void;
  isAllTime: boolean;
  onTryAllTime: () => void;
}) {
  if (identities.total === 0 && windows.total === 0) {
    return <NoResults search={search} isAllTime={isAllTime} onTryAllTime={onTryAllTime} />;
  }
  const loadedWindowIds = windows.rows.flatMap((group) => group.sessionIds);
  const allWindowsSelected = loadedWindowIds.length > 0
    && loadedWindowIds.every((id) => selectedSessionIds.has(id));
  return (
    <div className="flex flex-col gap-6">
      {identities.total > 0 && (
        <ResultGroup title="Apps and websites" count={identities.total}>
          <EntityTable
            rows={identities.rows}
            scale={scale}
            sort={sort}
            direction={direction}
            onSort={onSort}
            selectedEntityId={selectedEntityId}
            onSelect={onSelectEntity}
            headOffset="top-8"
          />
          {identities.rows.length < identities.total && (
            <LoadMore shown={identities.rows.length} total={identities.total} onClick={onLoadIdentities} />
          )}
        </ResultGroup>
      )}
      {windows.total > 0 && (
        <ResultGroup
          title="Window matches"
          count={windows.total}
          // What the grouping collapsed, so the number is accounted for rather
          // than quietly smaller than it used to be.
          subtitle={windows.sessionTotal > windows.total
            ? `${windows.sessionTotal} visits`
            : undefined}
          // Only worth saying while a type filter is set, which is the only
          // time the exception can read as a bug. A stored title has no kind
          // of its own, so narrowing by one would drop the rows searched for.
          note={typeFilter === "all" ? undefined : {
            label: "all types",
            title: "Window titles are matched whatever the type filter is set to — a stored title belongs to the session, not to an app or a website.",
          }}
          action={
            <Checkbox
              checked={allWindowsSelected}
              onChange={() => onToggleAllSessions(loadedWindowIds)}
              className="text-[11px] text-ink-3 hover:text-ink-2"
            >
              {allWindowsSelected ? "Clear" : `Select all ${loadedWindowIds.length} visits`}
            </Checkbox>
          }
        >
          <WindowGroupTable
            rows={windows.rows}
            search={search}
            selected={selectedSessionIds}
            onToggleGroup={onToggleAllSessions}
            onToggleSession={onToggleSession}
            onEdit={onEditSession}
            onMakeRule={onMakeRule}
          />
          {/* Paging belongs to the list, so it stays against the table it
              extends; the destructive action terminates the group. */}
          {windows.rows.length < windows.total && (
            <LoadMore shown={windows.rows.length} total={windows.total} onClick={onLoadWindows} />
          )}
          {selectedSessionIds.size > 0 && (
            <div className="mt-3 flex items-center justify-end gap-3">
              <span className="text-[11px] tabular-nums text-ink-3">{selectedSessionIds.size} selected</span>
              <Button variant="danger" onClick={onDeleteSelected}>Delete selected…</Button>
            </div>
          )}
        </ResultGroup>
      )}
    </div>
  );
}

/**
 * The heading sticks along with the table it names. Without it, scrolling deep
 * into either group left a column header stuck to the top that could have
 * belonged to either table — and at the handoff the incoming group's label was
 * the one thing hidden, sliding under the outgoing table's header.
 *
 * Sentence case at ink-2 so it outranks the column headings beneath it. The two
 * were within half a pixel of each other, both uppercase and both ink-3, which
 * left "this is a section of the results" reading as one more column name.
 */
function ResultGroup({
  title,
  count,
  subtitle,
  note,
  action,
  children,
}: {
  title: string;
  count: number;
  subtitle?: string;
  note?: { label: string; title: string };
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="sticky top-0 z-20 flex h-8 items-center gap-2 bg-surface">
        <h3 className="text-[12.5px] font-medium text-ink-2">{title}</h3>
        <span className="text-[11px] tabular-nums text-ink-3">{count}</span>
        {subtitle && <span className="text-[11px] tabular-nums text-ink-3">· {subtitle}</span>}
        {note && (
          <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9.5px] font-medium leading-[1.4] text-ink-3" title={note.title}>
            {note.label}
          </span>
        )}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function EntityTable({
  rows,
  scale,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelect,
  headOffset,
}: {
  rows: ActivityEntitySummary[];
  scale: BarScale;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelect: (id: string) => void;
  headOffset?: string;
}) {
  return (
    <div>
      <table className="w-full min-w-[680px] table-fixed text-xs">
        {/* Sticky via a shadow, not a border: a collapsed table's borders do not
            travel with a stuck header row. */}
        <StickyHead offset={headOffset}>
          <tr className="text-left text-[10.5px] uppercase tracking-[.04em] text-ink-3">
            <SortHeading label="Name" field="name" active={sort === "name"} direction={direction} onSort={onSort} className="w-[27%] text-left" />
            {/* Bar then duration, as in Top Apps. The column is kept barely
                wider than the longest duration it can hold, because a
                right-aligned number leaves a ragged left edge — the wider the
                column, the further a short duration drifts from its own bar.
                No heading: the bar draws what Time already sorts, so a second
                one would name a dimension it cannot order independently. */}
            <th className="w-[37%] pb-2"><span className="sr-only">Time relative to the busiest item</span></th>
            <SortHeading label="Time" field="seconds" active={sort === "seconds"} direction={direction} onSort={onSort} className="w-[9%] text-right" />
            {/* Centered, unlike the other numbers: a count that is nearly
                always one or two digits, right-aligned, strands the digit at
                the column edge with a hole beside it. Nothing here is read
                down the column digit by digit, which is what right alignment
                would buy. Centring only pays off if the column is wide enough
                that its middle falls between its neighbours — a narrow one
                parks the digit against Time and leaves the whole gap on the
                other side. That width is why Last seen gives up four points it
                does not need, and the left padding is the last 16px of it:
                Last seen is right-aligned, so its text starts further in than
                its column does, and matching the two gaps means offsetting the
                centre by half that difference. */}
            <SortHeading label="Days seen" field="days" active={sort === "days"} direction={direction} onSort={onSort} className="w-[15%] pl-8 text-center" />
            <SortHeading label="Last seen" field="lastSeen" active={sort === "lastSeen"} direction={direction} onSort={onSort} className="w-[12%] text-right" />
          </tr>
        </StickyHead>
        <tbody>
          {rows.map((entity) => (
            <tr
              key={entity.id}
              className={`cursor-pointer border-b border-edge/40 transition-colors hover:bg-white/[.035] ${selectedEntityId === entity.id ? "bg-white/[.05]" : ""}`}
              onClick={() => onSelect(entity.id)}
            >
              <td className="py-2.5 pr-4">
                <span className="flex min-w-0 flex-col gap-0.5">
                  {/* Every tag rides with the name, because each is a fact
                      about the item: this one is new, that one is barely used.
                      The line below is only how the row has been filed. Split
                      across the two, a row that was both new and rare wore one
                      badge on each line for no reason a reader could see. */}
                  <span className="flex min-w-0 items-center gap-1.5">
                    {/* The row is clickable for the mouse, but the keyboard
                        needs a real control to land on — a focusable <tr>
                        announces a row, not something that opens anything. */}
                    <button
                      type="button"
                      title={entity.key}
                      onClick={(event) => { event.stopPropagation(); onSelect(entity.id); }}
                      className="truncate rounded-sm text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                    >
                      {entity.displayName}
                      <span className="sr-only"> — open details</span>
                    </button>
                    {entity.isNew && (
                      <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
                    )}
                    {entity.noise && (
                      <RowTag
                        title={entity.noise === "utility"
                          ? "Looks like an installer, driver, or local file — normally hidden from this list."
                          : "Seen briefly and rarely across all history — normally hidden from this list."}
                      >
                        {entity.noise === "utility" ? "Utility" : "Rare"}
                      </RowTag>
                    )}
                  </span>
                  {/* leading-none clipped descenders (the "g" in "browsing"):
                      the truncate children below are overflow-hidden, so their
                      box is exactly the font size and anything under the
                      baseline is cut. A little line-height gives them room. */}
                  <span className="flex min-w-0 items-center gap-1.5 text-[10px] leading-[1.4] text-ink-3">
                    <ClassificationLabel entity={entity} />
                    <span aria-hidden="true" className="shrink-0">·</span>
                    <span className="shrink-0 capitalize">{entity.kind}</span>
                  </span>
                </span>
              </td>
              <td className="py-2.5 pr-4">
                <ShareBar seconds={entity.seconds} maxSeconds={scale.maxSeconds} totalSeconds={scale.totalSeconds} />
              </td>
              <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(entity.seconds)}</td>
              <td className="py-2.5 pl-8 text-center tabular-nums text-ink-3">{entity.daysSeen}</td>
              <td className="py-2.5 text-right tabular-nums text-ink-3">{formatLastSeen(entity.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What every bar in one table is measured against: the heaviest row sets the
 *  length, the range total sets the share reported on hover. Kept together so
 *  the two can never be threaded through from different result sets. */
type BarScale = Pick<ActivityQueryResult, "maxSeconds" | "totalSeconds">;

/**
 * A filled pill and nothing else. The fill alone is what holds a tag apart
 * from the name beside it, which is why the border and the capitals both went:
 * each was a third and fourth way of saying "this is a badge", and together
 * they built a block twice the height of the word they annotated. Sentence
 * case also keeps them in the app's voice, and the shape matches the drawer's
 * Corrected mark, the one tag that already existed.
 *
 * Colour and size are set here rather than inherited, since these sit on the
 * name's line and a tag taking its brightness would outshout it.
 *
 * Only two tones, and never one per tag: the label is already the distinction,
 * so hue would restate it — the same reason the category dot left this table.
 * "accent" marks a fact about the item worth noticing, "muted" a reason the
 * row is normally hidden. Accent is safe here because it is the interface's
 * own colour rather than any category's.
 */
function RowTag({
  title,
  tone = "muted",
  children,
}: {
  title: string;
  tone?: "muted" | "accent";
  children: ReactNode;
}) {
  const styles = tone === "accent" ? "bg-accent/10 text-accent/85" : "bg-surface-3 text-ink-3";
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium leading-[1.4] ${styles}`}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Length relative to the heaviest row the filters admit, as in Top Apps: a
 * full bar is "the most of anything here". Drawing the absolute share of all
 * recorded time is the more literal reading, but no single app is a large
 * fraction of a whole month — every row collapsed into the same short stub,
 * which is the one thing a bar exists to prevent. The absolute share is still
 * exact on hover, where a number can be read properly anyway.
 *
 * One accent fill: length is all the bar encodes, and the row's category is
 * already spelled out under its name.
 */
function ShareBar({
  seconds,
  maxSeconds,
  totalSeconds,
}: {
  seconds: number;
  maxSeconds: number;
  totalSeconds: number;
}) {
  if (maxSeconds <= 0) return null;
  const share = totalSeconds > 0 ? seconds / totalSeconds : 0;
  return (
    <span
      aria-hidden="true"
      title={`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% of recorded time in range`}
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${Math.max((seconds / maxSeconds) * 100, 1.5)}%` }}
      />
    </span>
  );
}

/**
 * Classification as the first thing on the row's metadata line. The word alone
 * carries it: a dot here would be a second encoding of what the label already
 * says, and the states that most need telling apart — uncategorized, partly
 * uncategorized, ignored — all share one gray, so it distinguished nothing
 * where it mattered most.
 */
function ClassificationLabel({ entity }: { entity: ActivityEntitySummary }) {
  if (entity.status === "uncategorized") return <span>Uncategorized</span>;
  if (entity.status === "partial") {
    // "Mixed" is the app's one word for "not one clean category", covering both
    // this and the several-categories case below. The tooltip carries what the
    // longer label used to say.
    return (
      <span title={`${fmtDuration(entity.uncategorizedSeconds)} of this is still uncategorized`}>
        Mixed
      </span>
    );
  }
  if (entity.status === "ignored") {
    return <span title="Recorded, but left out of every Insights total.">Ignored</span>;
  }
  const category = entity.categories[0];
  const label = entity.status === "mixed"
    ? `${category.name} +${entity.categories.length - 1}`
    : (category?.name ?? "Uncategorized");
  return (
    <span
      className="truncate"
      title={entity.status === "mixed"
        ? `Categorized differently across its sessions — ${entity.categories.map((slice) => `${slice.name} ${fmtDuration(slice.seconds)}`).join(", ")}`
        : undefined}
    >
      {label}
    </span>
  );
}

/**
 * Windows, not intervals.
 *
 * One row per distinct title, carrying how many times it was returned to and
 * how long that came to. The tracker's own unit — an uninterrupted spell in the
 * foreground — is the wrong thing to hand someone: half of a real database's
 * rows last under ten seconds and carry a few percent of its time, so a search
 * answered row by row buries what was asked for under hundreds of fragments of
 * the same window. Expanding a row puts the intervals back for the cases that
 * genuinely need them.
 */
function WindowGroupTable({
  rows,
  search,
  selected,
  onToggleGroup,
  onToggleSession,
  onEdit,
  onMakeRule,
  showIdentity = true,
}: {
  rows: ActivityTitleGroup[];
  search: string;
  selected: Set<number>;
  onToggleGroup: (ids: number[]) => void;
  onToggleSession: (id: number) => void;
  onEdit: (id: number) => void;
  onMakeRule: (group: ActivityTitleGroup) => void;
  /** The drawer already names the app in its header; only search results have
   *  to say which one each window belongs to. */
  showIdentity?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div>
      <table className="w-full min-w-[720px] table-fixed text-xs">
        <StickyHead offset="top-8">
          <tr className="text-left text-[10.5px] uppercase tracking-[.04em] text-ink-3">
            <th className="w-9 pb-2"><span className="sr-only">Select</span></th>
            {/* The widest column, because the title is the only reason any of
                these rows is in the list. */}
            <th className={`${showIdentity ? "w-[44%]" : "w-[58%]"} pb-2 font-medium`}>Window</th>
            {showIdentity && <th className="w-[14%] pb-2 font-medium">App / Website</th>}
            <th className="w-[16%] pb-2 font-medium">Classification</th>
            <th className="w-[9%] pb-2 text-right font-medium">Visits</th>
            <th className="w-[9%] pb-2 text-right font-medium">Time</th>
            <th className="w-16 pb-2"><span className="sr-only">Actions</span></th>
          </tr>
        </StickyHead>
        <tbody>
          {rows.map((group) => {
            const open = expanded.has(group.key);
            const allSelected = group.sessionIds.every((id) => selected.has(id));
            const someSelected = !allSelected && group.sessionIds.some((id) => selected.has(id));
            return (
              <Fragment key={group.key}>
                <tr className={`border-b border-edge/40 transition-colors ${allSelected || someSelected ? "bg-white/[.05]" : ""}`}>
                  <td className="py-2.5">
                    <Checkbox
                      size="md"
                      checked={allSelected}
                      indeterminate={someSelected}
                      onChange={() => onToggleGroup(group.sessionIds)}
                      label={`Select all ${group.sessionCount} visits to ${group.title}`}
                    />
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {/* The disclosure is the title itself: a separate chevron
                          would be a second control for one action. */}
                      <button
                        type="button"
                        onClick={() => toggleExpanded(group.key)}
                        aria-expanded={open}
                        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                      >
                        <Chevron open={open} />
                        <MatchedTitle title={group.title} search={search} />
                      </button>
                    </span>
                  </td>
                  {showIdentity && (
                    <td className="truncate py-2.5 pr-3" title={group.entityKey}>{group.displayName}</td>
                  )}
                  <td className="min-w-0 py-2.5 pr-3 text-ink-2">
                    <span className="block truncate">
                      {group.mixed ? "Mixed" : group.categoryName ?? "Uncategorized"}
                    </span>
                    <span className="block truncate text-[10px] text-ink-3">
                      {group.mixed
                        ? "Its visits classify differently"
                        : group.winningRulePattern
                          ? `${RULE_LABELS[group.winningRuleType!]} · ${group.winningRulePattern}`
                          : "No matching rule"}
                    </span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-ink-3">{group.sessionCount}</td>
                  <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(group.seconds)}</td>
                  <td className="py-2.5 text-right">
                    {/* The bridge from "I found a pattern" to "classify it
                        forever". Without it the only bulk verb here is delete,
                        which is backwards for an app about classification. */}
                    <button
                      type="button"
                      onClick={() => onMakeRule(group)}
                      title="Create a Window rule from this title"
                      className="rounded px-1.5 py-1 text-[10.5px] text-ink-3 hover:bg-accent/10 hover:text-accent"
                    >
                      Rule…
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr className="border-b border-edge/40 bg-surface-2/40">
                    <td />
                    <td colSpan={showIdentity ? 6 : 5} className="py-2 pr-3">
                      <GroupSessions
                        group={group}
                        selected={selected}
                        onToggle={onToggleSession}
                        onEdit={onEdit}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`h-3 w-3 shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** The intervals behind one window, for the rare case that needs them: which
 *  exact visit to correct, or proof of when something actually happened. */
function GroupSessions({
  group,
  selected,
  onToggle,
  onEdit,
}: {
  group: ActivityTitleGroup;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onEdit: (id: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {group.sessions.map((session) => (
        <div key={session.id} className="flex items-center gap-2 text-[11px]">
          <Checkbox
            checked={selected.has(session.id)}
            onChange={() => onToggle(session.id)}
            label={`Select the visit starting ${formatDateTime(session.start)}`}
          />
          <span className="tabular-nums text-ink-2">{formatDateTime(session.start)}</span>
          <span className="tabular-nums text-ink-3">{fmtDuration(session.seconds)}</span>
          {session.isCorrected && (
            <span className="rounded-full bg-accent/10 px-1.5 py-[1px] text-[9px] text-accent">Corrected</span>
          )}
          <button
            type="button"
            onClick={() => onEdit(session.id)}
            className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:bg-accent/10 hover:text-accent"
          >
            Edit
          </button>
        </div>
      ))}
      {group.sessionCount > group.sessions.length && (
        // Never silently truncated: the count above says how many visits there
        // were, so the difference has to be accounted for.
        <span className="pt-1 text-[10.5px] text-ink-3">
          Showing the {group.sessions.length} most recent of {group.sessionCount} visits. Selecting
          the window still takes all {group.sessionCount}.
        </span>
      )}
    </div>
  );
}

/** Characters of the title kept ahead of the match, enough to read it in
 *  context without pushing the match itself back out of view. */
const MATCH_LEAD = 16;

/**
 * Splits a stored title around the search text. Null means there is nothing to
 * mark, so the caller renders the title plainly.
 *
 * `elided` reports that the title was cut in front of the match: plain
 * truncation clips from the right, so a match deep in a long title left a row
 * with no visible reason to be in the list. Matching is
 * case-insensitive but the returned text is the stored casing, since the point
 * is to show what was actually recorded.
 */
export function titleMatchParts(title: string, search: string): {
  elided: boolean;
  head: string;
  hit: string;
  tail: string;
} | null {
  if (!title || !search) return null;
  const at = title.toLowerCase().indexOf(search.toLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - MATCH_LEAD);
  return {
    elided: from > 0,
    head: title.slice(from, at),
    hit: title.slice(at, at + search.length),
    tail: title.slice(at + search.length),
  };
}

/**
 * A window match is in the list for exactly one reason — its stored title
 * contains the search text — so the match is windowed into view and marked,
 * where before it could sit past the column's width and leave the row looking
 * unjustified.
 */
function MatchedTitle({ title, search }: { title: string; search: string }) {
  if (!title) return <span className="text-ink-3">—</span>;
  const parts = titleMatchParts(title, search);
  if (!parts) return <span className="block truncate" title={title}>{title}</span>;
  return (
    <span className="block truncate" title={title}>
      {parts.elided && <span className="text-ink-3">…</span>}
      {parts.head}
      <mark className="rounded-[2px] bg-accent/20 px-[1px] text-ink">{parts.hit}</mark>
      {parts.tail}
    </span>
  );
}

/** Exclusions are per-entity curation, like corrections and deletions, so they
 *  live beside them instead of behind a second CRUD surface in Settings. */
function ExcludedPanel() {
  const banner = useBanner();
  const [items, setItems] = useState<TrackingExclusion[] | null>(null);
  const [kind, setKind] = useState<TrackingExclusionKind>("app");
  const [draft, setDraft] = useState("");
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => listTrackingExclusions()
    .then(setItems)
    .catch((error: unknown) => banner.report(error, "tracking exclusions"));
  useEffect(() => { void load(); }, []);

  const add = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      const preview = await previewTrackingExclusion(kind, draft);
      if (deleteHistory && preview.count > 0 && !window.confirm(
        `Delete ${preview.count} existing session${preview.count === 1 ? "" : "s"} (${fmtDuration(preview.seconds)}) for ${preview.normalizedPattern}?\n\nThis cannot be undone without a backup.`,
      )) {
        setSaving(false);
        return;
      }
      const result = await addTrackingExclusion(kind, draft, deleteHistory);
      banner.show(deleteHistory
        ? `Excluded ${result.normalizedPattern} and deleted ${result.deletedCount} historical session${result.deletedCount === 1 ? "" : "s"}.`
        : `Excluded ${result.normalizedPattern} from future tracking.`);
      setDraft("");
      setDeleteHistory(false);
      await load();
    } catch (error) {
      banner.report(error, "tracking exclusion");
    } finally {
      setSaving(false);
    }
  };

  const lift = async (item: TrackingExclusion) => {
    try {
      await removeTrackingExclusion(item.kind, item.pattern);
      banner.show(`${item.pattern} can be tracked again. Deleted history was not restored.`);
      await load();
    } catch (error) {
      banner.report(error, "tracking exclusion");
    }
  };

  if (items === null) return <Spinner />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="shrink-0 text-[11px] leading-snug text-ink-3">
        Exact exclusions stop matching apps or detected websites from ever being stored, whenever
        recording is enabled. Lifting one resumes tracking from now on; history deleted with the
        exclusion is not restored.
      </p>
      <div className="scroll-well flex min-h-[160px] flex-1 flex-col gap-1.5 overflow-auto pr-4">
        {items.map((item) => (
          <div key={`${item.kind}:${item.pattern}`} className="flex items-center gap-2.5 rounded-lg border border-edge/60 bg-surface-2 px-3 py-2">
            <RuleKindGlyph matchType={item.kind === "app" ? "process" : "domain"} />
            <span className="w-[70px] shrink-0 text-[10px] uppercase tracking-[.04em] text-ink-3">{item.kind === "app" ? "App" : "Website"}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" title={item.pattern}>{item.pattern}</span>
            <span className="shrink-0 text-[10.5px] text-ink-3">since {formatShortDate(item.createdTs)}</span>
            <RemoveButton label={`Allow ${item.pattern} to be tracked again`} onClick={() => void lift(item)} />
          </div>
        ))}
        {items.length === 0 && (
          <p className="py-6 text-center text-[11.5px] text-ink-3">
            Nothing is excluded. Open an app or website and choose “Do not track…” to add one.
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-edge/50 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex rounded-lg border border-edge bg-surface-2 p-0.5">
            {(["app", "website"] as TrackingExclusionKind[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`rounded-md px-2.5 py-1 text-[10.5px] ${kind === option ? "bg-surface-3 text-ink-2" : "text-ink-3 hover:text-ink-2"}`}
                onClick={() => setKind(option)}
              >
                {option === "app" ? "App" : "Website"}
              </button>
            ))}
          </span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void add(); }}
            placeholder={kind === "app" ? "code.exe" : "example.com"}
            aria-label={kind === "app" ? "App to exclude" : "Website to exclude"}
            className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
          />
          <Button variant="primary" disabled={saving || !draft.trim()} onClick={() => void add()}>Do not track</Button>
        </div>
        <Checkbox checked={deleteHistory} onChange={setDeleteHistory} className="mt-2 text-[10.5px] text-ink-3">
          Also delete matching history, after a count preview
        </Checkbox>
        {kind === "website" && (
          <p className="mt-1 text-[10px] text-ink-3">
            Website exclusions need a detected browser domain; otherwise exclude the whole browser as an App.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Two different dead ends, and they were sharing one sentence: an empty range
 * and a search that matched nothing are not the same problem, even though
 * widening the range is worth offering for both.
 */
function NoResults({
  isAllTime,
  onTryAllTime,
  search,
}: {
  isAllTime: boolean;
  onTryAllTime: () => void;
  search?: string;
}) {
  return (
    <div className="flex h-36 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-3">
      <span className="max-w-[36ch] truncate">
        {search ? <>No matches for &ldquo;{search}&rdquo; in this range</> : "No activity found in this range"}
      </span>
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

/**
 * One window in the drawer's list. Card-shaped rather than tabular because the
 * drawer is a narrow column, and its sibling sections are all cards.
 *
 * With titles hidden the row still says everything a session row used to —
 * when, how long, how it classifies — and withholds only the words themselves.
 */
function DrawerWindowGroup({
  group,
  showTitle,
  search,
  selected,
  onToggleGroup,
  onToggleSession,
  onEditSession,
  onMakeRule,
}: {
  group: ActivityTitleGroup;
  showTitle: boolean;
  search: string;
  selected: Set<number>;
  onToggleGroup: (ids: number[]) => void;
  onToggleSession: (id: number) => void;
  onEditSession: (id: number) => void;
  onMakeRule: (group: ActivityTitleGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const allSelected = group.sessionIds.every((id) => selected.has(id));
  const someSelected = !allSelected && group.sessionIds.some((id) => selected.has(id));
  return (
    <div className="rounded-lg border border-edge/60 px-2.5 py-2 text-[11px] hover:bg-white/[.018]">
      <div className="flex items-start gap-2">
        <Checkbox
          size="md"
          align="start"
          checked={allSelected}
          indeterminate={someSelected}
          onChange={() => onToggleGroup(group.sessionIds)}
          label={`Select all ${group.sessionCount} visits to this window`}
        />
        <span className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
          >
            <Chevron open={open} />
            <span className="min-w-0 flex-1 text-ink-2">
              {showTitle
                ? <MatchedTitle title={group.title} search={search} />
                : <span className="italic text-ink-3">Window title hidden</span>}
            </span>
          </button>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ink-3">
            <span className="tabular-nums">{group.sessionCount} visit{group.sessionCount === 1 ? "" : "s"}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{fmtDuration(group.seconds)}</span>
            <span aria-hidden="true">·</span>
            <span>{group.mixed ? "Mixed" : group.categoryName ?? "Uncategorized"}</span>
            {!group.mixed && group.winningRuleType && (
              <>
                <span aria-hidden="true">·</span>
                <span>{RULE_LABELS[group.winningRuleType]} rule</span>
              </>
            )}
          </span>
        </span>
        <button
          type="button"
          onClick={() => onMakeRule(group)}
          title="Create a Window rule from this title"
          className="shrink-0 rounded px-1.5 py-1 text-[10.5px] text-ink-3 hover:bg-accent/10 hover:text-accent"
        >
          Rule…
        </button>
      </div>
      {open && (
        <div className="mt-2 border-t border-edge/60 pt-2">
          <GroupSessions
            group={group}
            selected={selected}
            onToggle={onToggleSession}
            onEdit={onEditSession}
          />
        </div>
      )}
    </div>
  );
}

function EntityDrawer({
  entity,
  groups,
  hasStoredTitles,
  detailSearch,
  onDetailSearch,
  showTitles,
  onShowTitles,
  onLoadMore,
  onClose,
  categories,
  aliases,
  selectedSessionIds,
  onToggleSession,
  onToggleAllSessions,
  onDeleteSelected,
  onDeleteEntity,
  onExclude,
  onEditSession,
  onMakeRule,
  onAssign,
  onSaveAlias,
  onRemoveExactRule,
}: {
  entity: ActivityEntitySummary;
  groups: ActivityTitleGroupPage;
  hasStoredTitles: boolean;
  detailSearch: string;
  onDetailSearch: (value: string) => void;
  showTitles: boolean;
  onShowTitles: (show: boolean) => void;
  onLoadMore: () => void;
  onClose: () => void;
  categories: Category[];
  aliases: Record<string, string>;
  selectedSessionIds: Set<number>;
  onToggleSession: (id: number) => void;
  onToggleAllSessions: (ids: number[]) => void;
  onDeleteSelected: () => void;
  onDeleteEntity: () => void;
  onExclude: () => void;
  onEditSession: (id: number) => void;
  onMakeRule: (group: ActivityTitleGroup) => void;
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
        <div className="scroll-well flex-1 overflow-y-auto p-5">
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
              {/* An action menu, not a selection: assigning fires a command
                  and the trigger falls back to its prompt, because an entity
                  can hold several categories at once and no single one of
                  them is "the" current value. */}
              <MenuSelect
                value=""
                placeholder={entity.kind === "website" ? "Set website category…" : "Set app default…"}
                label={entity.kind === "website" ? "Set website category" : "Set app default"}
                onChange={(value) => void onAssign(Number(value))}
                options={categories.map((category) => ({
                  value: String(category.id),
                  label: category.name,
                }))}
              />
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
          {/* Windows rather than raw sessions, for the same reason search
              results changed: this entity's list is one app's worth of the
              same fragmentation, and "45 windows" is a thing to read where
              "1269 sessions" is not. */}
          <section className="mt-5">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold">Windows</h3>
              <span className="text-[10.5px] tabular-nums text-ink-3">
                {groups.total}
                {groups.sessionTotal > groups.total && ` · ${groups.sessionTotal} visits`}
              </span>
              <span className="flex-1" />
              {selectedSessionIds.size > 0 && <Button variant="danger" onClick={onDeleteSelected}>Delete selected…</Button>}
            </div>
            {hasStoredTitles && (
              <div className="mt-3 flex items-center gap-3">
                <input value={detailSearch} onChange={(event) => onDetailSearch(event.target.value)} placeholder="Filter windows…" className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60" />
                {/* Named, and independent of the filter box. Hiding titles
                    until something was typed tied a privacy decision to an
                    unrelated control, and one keystroke undid it anyway. */}
                <Checkbox
                  checked={showTitles}
                  onChange={onShowTitles}
                  className="shrink-0 text-[11px] text-ink-3 hover:text-ink-2"
                >
                  Show titles
                </Checkbox>
              </div>
            )}
            <div className="mt-3 flex flex-col gap-1.5">
              {groups.rows.map((group) => (
                <DrawerWindowGroup
                  key={group.key}
                  group={group}
                  showTitle={showTitles}
                  search={detailSearch}
                  selected={selectedSessionIds}
                  onToggleGroup={onToggleAllSessions}
                  onToggleSession={onToggleSession}
                  onEditSession={onEditSession}
                  onMakeRule={onMakeRule}
                />
              ))}
              {groups.rows.length === 0 && <p className="py-5 text-center text-[11px] text-ink-3">No windows match this filter.</p>}
            </div>
            {groups.rows.length < groups.total && <LoadMore shown={groups.rows.length} total={groups.total} onClick={onLoadMore} />}
          </section>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-edge px-5 py-4">
          <p className="max-w-72 text-[10.5px] leading-snug text-ink-3">Deletes complete session rows overlapping the visible range. Categories, rules, and aliases are kept.</p>
          <span className="flex shrink-0 items-center gap-2">
            <Button onClick={onExclude}>Do not track…</Button>
            <Button variant="danger" onClick={onDeleteEntity}>Delete activity in range…</Button>
          </span>
        </div>
      </aside>
    </>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-edge bg-surface-2 p-3"><p className="text-[10px] text-ink-3">{label}</p><p className="mt-1 text-sm font-semibold tabular-nums">{value}</p></div>;
}

function ActivityExportMenu({
  source,
  range,
  hasStoredTitles,
}: {
  source: ActivitySource;
  range: Range;
  hasStoredTitles: boolean;
}) {
  const banner = useBanner();
  const [includeTitles, setIncludeTitles] = useState(false);
  const [exporting, setExporting] = useState<ActivityExportKind | null>(null);
  const run = async (kind: ActivityExportKind) => {
    setExporting(kind);
    try {
      const file = buildActivityExport(
        kind,
        source,
        range.start.getTime() / 1000,
        range.end.getTime() / 1000,
        kind === "sessions" && includeTitles,
      );
      const path = await saveActivityExport(file.suggestedName, file.contents);
      if (path) banner.show(`Export saved to ${path}`);
    } catch (error) {
      banner.report(error, "export");
    } finally {
      setExporting(null);
    }
  };
  // A <details> keeps the disclosure free, but not the dismissal every other
  // menu in the app gives: without these it stays open until clicked again.
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: Event) => {
      const node = panel.current;
      if (node?.open && !node.contains(event.target as Node)) node.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel.current?.open) panel.current.open = false;
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <details ref={panel} className="relative">
      <summary className="cursor-pointer list-none rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-2 hover:bg-white/[.035]">Export</summary>
      <div className="absolute right-0 top-9 z-30 w-64 rounded-xl border border-edge bg-surface p-3 shadow-xl">
        <p className="text-[10.5px] leading-snug text-ink-3">Uses the selected date range. Search and library filters do not remove rows.</p>
        <div className="mt-3 flex flex-col gap-2">
          <Button disabled={exporting !== null} onClick={() => void run("summary")}>{exporting === "summary" ? "Preparing…" : "Activity summary CSV"}</Button>
          <Button disabled={exporting !== null} onClick={() => void run("sessions")}>{exporting === "sessions" ? "Preparing…" : "Session details CSV"}</Button>
        </div>
        {hasStoredTitles && (
          <Checkbox
            checked={includeTitles}
            onChange={setIncludeTitles}
            align="start"
            className="mt-3 text-[10.5px] leading-snug text-ink-3"
          >
            Include stored window titles. They may contain private data.
          </Checkbox>
        )}
      </div>
    </details>
  );
}

function TrackingExclusionDialog({
  scope,
  onClose,
  onAdded,
}: {
  scope: { kind: TrackingExclusionKind; pattern: string; label: string };
  onClose: () => void;
  onAdded: (deletedHistory: boolean) => void;
}) {
  const banner = useBanner();
  const [preview, setPreview] = useState<{ count: number; seconds: number; normalizedPattern: string } | null>(null);
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void previewTrackingExclusion(scope.kind, scope.pattern).then(
      (value) => { if (!cancelled) setPreview(value); },
      (error) => { if (!cancelled) { banner.report(error, "tracking exclusion"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [scope]);
  const save = async () => {
    setSaving(true);
    try {
      const result = await addTrackingExclusion(scope.kind, scope.pattern, deleteHistory);
      banner.show(
        deleteHistory
          ? `Future tracking stopped and ${result.deletedCount} historical session${result.deletedCount === 1 ? " was" : "s were"} deleted.`
          : `Time will no longer track ${scope.label}.`,
      );
      onAdded(deleteHistory);
    } catch (error) {
      banner.report(error, "tracking exclusion");
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="exclude-title">
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-5 shadow-2xl">
        <h2 id="exclude-title" className="text-base font-semibold">Do not track {scope.label}</h2>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">This exact {scope.kind === "website" ? "website" : "app"} identity will be excluded whenever recording is enabled.</p>
        <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 font-mono text-[11px] text-ink-2">{preview?.normalizedPattern ?? scope.pattern}</p>
        {scope.kind === "website" && <p className="mt-2 text-[10.5px] text-ink-3">Website exclusions work only when Time can detect the browser domain.</p>}
        <Checkbox
          checked={deleteHistory}
          onChange={setDeleteHistory}
          align="start"
          className="mt-4 rounded-lg border border-bad/20 bg-bad/[.035] p-3 text-[11px] leading-snug text-ink-2"
        >
          <span><span className="block font-medium">Also delete existing history</span>{preview ? `${preview.count} session${preview.count === 1 ? "" : "s"} · ${fmtDuration(preview.seconds)}. This cannot be undone without a backup.` : "Checking matching history…"}</span>
        </Checkbox>
        <div className="mt-5 flex justify-end gap-2"><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving || !preview} onClick={() => void save()}>{saving ? "Saving…" : "Add exclusion"}</Button></div>
      </div>
    </div>
  );
}

/**
 * Says what room a correction actually has, before anything is typed.
 *
 * A corrected span may not overlap another recording. Because the tracker
 * records continuously while the machine is on, the neighbours usually sit
 * flush against the session, so the honest answer is normally "you can shorten
 * this, not lengthen it" — which is exactly what someone needs to know first
 * and what the old dialog only revealed by rejecting the save.
 */
export function describeCorrectionWindow(
  session: Pick<SessionCorrection, "start" | "end" | "earliestStart" | "latestEnd">,
): string {
  const { earliestStart, latestEnd } = session;
  // Seconds included: the fields below are second-granular, and a real gap is
  // often shorter than a minute — the tracker being restarted leaves one of
  // about forty seconds. Rounded to the minute, such a bound reads as though
  // there were no room at all.
  const clock = (seconds: number) =>
    new Date(seconds * 1000).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  // Every branch leads with what can be done, in the app's own noun. Naming the
  // mechanism first — which recording abuts which — makes the reader work for
  // the one thing they opened the panel to find out.
  if (earliestStart == null && latestEnd == null) {
    return "Nothing else is recorded around this session, so its times can move freely.";
  }
  if (earliestStart === session.start && latestEnd === session.end) {
    return "You can shorten this session but not extend it — the sessions before and after leave no gap.";
  }
  if (earliestStart == null) {
    return `Nothing is recorded before this session, and it can end as late as ${clock(latestEnd!)}.`;
  }
  if (latestEnd == null) {
    return `This session can start as early as ${clock(earliestStart)}, and nothing is recorded after it.`;
  }
  return `This session can run from ${clock(earliestStart)} to ${clock(latestEnd)} at most, before it would overlap another.`;
}

function localInputValue(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Turn a window someone just found into a standing rule.
 *
 * This is the flow that makes Window rules discoverable at all: they are the
 * only rule kind whose pattern is a fragment of something rather than a whole
 * identity, so nobody guesses them from an empty text field. Starting from a
 * concrete window means the pattern and the scope both have obvious defaults.
 *
 * The scope defaults to the app the window belongs to, not to "any app". A
 * title is evidence about the program showing it — "Skill Tree" in an editor is
 * a project, in a browser it might be anything — and the broader reading should
 * be a deliberate widening rather than what you get by not choosing.
 */
function WindowRuleDialog({
  group,
  categories,
  source,
  browserProcesses,
  onClose,
  onSaved,
}: {
  group: ActivityTitleGroup;
  categories: Category[];
  source: ActivitySource | null;
  browserProcesses: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const banner = useBanner();
  const [pattern, setPattern] = useState(() => defaultRulePattern(group.title));
  const [scope, setScope] = useState(() => defaultRuleScope(group, browserProcesses));
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  const trimmed = pattern.trim();
  // Counted against all of history, like the "unused" tag on a rule, because a
  // rule is not scoped to the visible range and pretending otherwise would
  // understate what it claims.
  const preview = useMemo(
    () => (source && trimmed ? previewTitleRule(source, trimmed, scope) : null),
    [source, trimmed, scope],
  );

  const save = async () => {
    setSaving(true);
    try {
      await addRule("title", trimmed, Number(categoryId), scope);
      banner.show(`Window rule “${trimmed}” added.`);
      onSaved();
    } catch (error) {
      banner.report(error, "rule");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="window-rule-title">
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-surface p-5 shadow-2xl">
        <h2 id="window-rule-title" className="text-base font-semibold">New Window rule</h2>
        <p className="mt-1 text-[11px] text-ink-3">
          Classifies any session whose stored window title contains these words. Applies to
          past and future activity alike.
        </p>

        <div className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px]">
          <p className="truncate font-medium" title={group.title}>{group.title}</p>
          <p className="mt-1 text-ink-3">
            {group.displayName} · {group.sessionCount} visit{group.sessionCount === 1 ? "" : "s"} · {fmtDuration(group.seconds)} in range
          </p>
        </div>

        <label className="mt-4 block text-[11px] text-ink-3">
          Words to match
          <input
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60"
          />
        </label>

        <div className="mt-3 text-[11px] text-ink-3">
          <span>Where it applies</span>
          <MenuSelect
            size="field"
            className="mt-1 w-full"
            value={scope}
            onChange={setScope}
            label="Rule scope"
            options={ruleScopeOptions(group, browserProcesses)}
          />
        </div>

        <div className="mt-3 text-[11px] text-ink-3">
          <span>Category</span>
          <MenuSelect
            size="field"
            className="mt-1 w-full"
            value={categoryId}
            onChange={setCategoryId}
            label="Category"
            options={[
              { value: "", label: "Choose a category…" },
              ...categories.map((category, i) => ({
                value: String(category.id),
                label: category.name,
                divider: i === 0,
              })),
            ]}
          />
        </div>

        {/* The safety net for a pattern aimed too widely: say what it takes
            before it takes it, counted over all history rather than the range
            on screen, because that is the scope a rule actually has. */}
        <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-3">
          {!trimmed
            ? "Enter the words this rule should match."
            : preview === null
              ? "Counting what this would match…"
              : preview.sessions === 0
                ? "Nothing in your history matches this yet. It will still apply to future activity."
                : (
                  <>
                    Claims <span className="text-ink-2">{preview.sessions}</span> session
                    {preview.sessions === 1 ? "" : "s"} across{" "}
                    <span className="text-ink-2">{preview.entities}</span>{" "}
                    {preview.entities === 1 ? "app or website" : "apps and websites"} —{" "}
                    <span className="text-ink-2">{fmtDuration(preview.seconds)}</span> of all
                    recorded time.
                    {preview.reclassified > 0 && (
                      <> <span className="text-ink-2">{preview.reclassified}</span> of them
                      currently classify differently and would change.</>
                    )}
                  </>
                )}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !trimmed || !categoryId}
            onClick={() => void save()}
          >
            {saving ? "Adding…" : "Add rule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The scope field's "One app is chosen, but not named yet" state. A lone dot
 *  cannot be a real executable name, so it can never be saved by accident. */
const SCOPE_PENDING = ".";

/** Whether a draft rule's scope is answerable. "Any app" is the empty string
 *  and perfectly valid; what is not is "One app" with nothing named yet, which
 *  is a half-made choice rather than a rule about an app called ".". */
function ruleDraftReady(draft: { type: MatchType; scope: string }): boolean {
  if (draft.type !== "title") return true;
  if (draft.scope === ANY_APP || draft.scope === BROWSER_SCOPE) return true;
  return draft.scope !== SCOPE_PENDING && draft.scope.trim() !== "";
}

/**
 * A first guess at the words worth matching. Window titles carry the document
 * first and the program last — "roadmap.md - Skill Tree - Obsidian" — so the
 * leading segment is the part that identifies the work, and the trailing ones
 * repeat what the scope already says.
 */
export function defaultRulePattern(title: string): string {
  const [first] = title.split(/\s+[-–—|·]\s+/);
  const guess = (first ?? "").trim();
  return guess.length >= 3 ? guess : title.trim();
}

function defaultRuleScope(group: ActivityTitleGroup, browserProcesses: string[]): string {
  // A website's sessions come from whichever browser was open at the time, so
  // pinning one executable would miss the others.
  if (group.entityKind === "website") return BROWSER_SCOPE;
  const process = group.sessions[0]?.process.toLowerCase();
  if (!process) return ANY_APP;
  return browserProcesses.includes(process) ? BROWSER_SCOPE : process;
}

function ruleScopeOptions(group: ActivityTitleGroup, browserProcesses: string[]): MenuOption[] {
  const process = group.sessions[0]?.process.toLowerCase();
  const options: MenuOption[] = [];
  if (process && !browserProcesses.includes(process)) {
    options.push({ value: process, label: `Only ${group.displayName} (${process})` });
  }
  options.push({ value: BROWSER_SCOPE, label: "Any browser" });
  options.push({ value: ANY_APP, label: "Any app" });
  return options;
}

interface TitleRulePreview {
  sessions: number;
  seconds: number;
  entities: number;
  /** Sessions the rule would pull away from whatever classifies them now —
   *  the number worth reading twice before pressing Add. */
  reclassified: number;
}

/**
 * What a proposed title rule would claim across all recorded history.
 *
 * Runs the real classifier twice rather than re-deriving what a match means:
 * once as things stand and once with the candidate rule added, so the answer
 * accounts for priority and scope exactly as the app will.
 */
export function previewTitleRule(
  source: ActivitySource,
  pattern: string,
  scope: string,
): TitleRulePreview {
  const needle = pattern.trim().toLowerCase();
  const browsers = new Set(source.browserProcesses.map((process) => process.toLowerCase()));
  const before = buildClassifier(source.categories, source.rules, browsers);
  // A priority below every real rule would not answer the question either; the
  // candidate has to sit exactly where a saved Window rule would.
  const candidate: Rule = {
    id: -1,
    matchType: "title",
    pattern: needle,
    categoryId: -1,
    priority: 2,
    scope,
  };
  const after = buildClassifier(
    [...source.categories, { id: -1, name: "", color: "#000", isProductive: false, isNeutral: true, isIgnored: false, sortOrder: null }],
    [...source.rules, candidate],
    browsers,
  );
  let sessions = 0;
  let seconds = 0;
  let reclassified = 0;
  const entities = new Set<string>();
  for (const session of source.sessions) {
    if (session.isAfk || !session.title) continue;
    if (!session.title.toLowerCase().includes(needle)) continue;
    if (after(session)?.id !== -1) continue; // outranked by an existing rule
    sessions += 1;
    seconds += Math.max(0, session.end - session.start);
    entities.add(session.domain ? `website:${session.domain}` : `app:${session.process.toLowerCase()}`);
    if (before(session) !== null) reclassified += 1;
  }
  return { sessions, seconds, entities: entities.size, reclassified };
}

function SessionCorrectionDialog({
  sessionId,
  categories,
  onClose,
}: {
  sessionId: number;
  categories: Category[];
  onClose: () => void;
}) {
  const banner = useBanner();
  const [session, setSession] = useState<SessionCorrection | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);
  // Folded by default. Reclassifying is the routine reason to open this dialog;
  // the recorded times are a repair for the rare occasion the clock went wrong,
  // and leading with them made the common action look like the afterthought.
  const [editingTimes, setEditingTimes] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchSessionCorrection(sessionId).then(
      (value) => {
        if (cancelled) return;
        setSession(value);
        setStart(localInputValue(value.start));
        setEnd(localInputValue(value.end));
        setCategoryId(value.categoryId == null ? "" : String(value.categoryId));
      },
      (error) => { if (!cancelled) { banner.report(error, "session"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [sessionId]);
  const save = async () => {
    if (!session) return;
    const startSec = new Date(start).getTime() / 1000;
    const endSec = new Date(end).getTime() / 1000;
    setSaving(true);
    try {
      await correctSession({
        sessionId,
        startSec,
        endSec,
        categoryId: categoryId ? Number(categoryId) : null,
      });
      banner.show("Session correction saved.");
      onClose();
    } catch (error) {
      banner.report(error, "session correction");
      setSaving(false);
    }
  };
  const reset = async () => {
    setSaving(true);
    try {
      await resetSessionCorrection(sessionId);
      banner.show("Session restored to its captured values.");
      onClose();
    } catch (error) {
      banner.report(error, "session correction");
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="correction-title">
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-surface p-5 shadow-2xl">
        <h2 id="correction-title" className="text-base font-semibold">Correct session</h2>
        {!session ? <div className="py-10"><Spinner /></div> : (
          <>
            <div className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px]"><p className="font-medium">{session.domain ?? session.process}</p>{session.title && <p className="mt-1 truncate text-ink-3" title={session.title}>{session.title}</p>}</div>
            {(session.isLive || session.isAfk) && <p className="mt-3 rounded-lg border border-bad/30 bg-bad/[.04] px-3 py-2 text-[11px] text-bad">{session.isLive ? "The current live session cannot be edited." : "AFK sessions are not editable in this version."}</p>}
            {/* Category leads: it is why this dialog is normally opened, it
                always succeeds, and it is the app's actual subject. */}
            <div className="mt-4 text-[11px] text-ink-3">
              <span>Category</span>
              <MenuSelect
                size="field"
                className="mt-1 w-full"
                value={categoryId}
                onChange={setCategoryId}
                label="Category"
                options={[
                  // Falling back to the rules is a different kind of answer
                  // from naming one category, so the rule marks the seam.
                  { value: "", label: "Use automatic classification" },
                  ...categories.map((category, i) => ({
                    value: String(category.id),
                    label: category.name,
                    divider: i === 0,
                  })),
                ]}
              />
            </div>

            <div className="mt-4 border-t border-edge/60 pt-3">
              <button
                type="button"
                onClick={() => setEditingTimes((open) => !open)}
                aria-expanded={editingTimes}
                className="flex w-full items-center gap-1.5 rounded-sm text-left text-[11px] text-ink-3 outline-none hover:text-ink-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
              >
                <Chevron open={editingTimes} />
                Adjust recorded times
                <span className="ml-auto tabular-nums">
                  {fmtDuration(Math.max(0, session.end - session.start))}
                </span>
              </button>
              {editingTimes && (
                <>
                  {/* Stated before the edit rather than after it fails. The
                      tracker records continuously, so the gap around a session
                      is usually the session itself — meaning it can be
                      shortened but almost never extended, which is worth
                      knowing before typing a time. */}
                  <p className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[10.5px] leading-snug text-ink-3">
                    {describeCorrectionWindow(session)}
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="text-[11px] text-ink-3">Start<input type="datetime-local" step="1" value={start} min={session.earliestStart == null ? undefined : localInputValue(session.earliestStart)} max={end} onChange={(event) => setStart(event.target.value)} className="mt-1 block w-full rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60" /></label>
                    <label className="text-[11px] text-ink-3">End<input type="datetime-local" step="1" value={end} min={start} max={session.latestEnd == null ? undefined : localInputValue(session.latestEnd)} onChange={(event) => setEnd(event.target.value)} className="mt-1 block w-full rounded-lg border border-edge bg-surface-2 px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60" /></label>
                  </div>
                  <p className="mt-2 text-[10.5px] leading-snug text-ink-3">Times use your local timezone and cannot end in the future.</p>
                </>
              )}
            </div>
            <div className="mt-5 flex items-center justify-between"><span>{session.isCorrected && <Button variant="danger" disabled={saving} onClick={() => void reset()}>Reset corrections</Button>}</span><span className="flex gap-2"><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving || session.isLive || session.isAfk || !start || !end} onClick={() => void save()}>{saving ? "Saving…" : "Save correction"}</Button></span></div>
          </>
        )}
      </div>
    </div>
  );
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
  appliedRuleIds,
  onChanged,
}: {
  /** null while history is still being read — no rule is "unused" until we
   *  have looked, and a tag that flashes on and off is worse than none. */
  appliedRuleIds: number[] | null;
  onChanged: () => Promise<void>;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set<number>());
  // Anchored to the swatch's measured position and rendered through a portal:
  // the category list scrolls now, and a menu positioned inside it would be
  // clipped by that scroll container the moment a row neared the bottom.
  const [colorMenu, setColorMenu] = useState<{ id: number; left: number; top: number } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newName, setNewName] = useState("");
  type RuleDraft = { type: MatchType; pattern: string; scope: string };
  const [drafts, setDrafts] = useState<Record<number, RuleDraft>>({});
  const applied = appliedRuleIds === null ? null : new Set(appliedRuleIds);

  const draftFor = (id: number): RuleDraft =>
    drafts[id] ?? { type: "domain" as const, pattern: "", scope: ANY_APP };
  const setDraft = (id: number, patch: Partial<RuleDraft>) =>
    setDrafts((current) => ({ ...current, [id]: { ...draftFor(id), ...patch } }));
  const toggle = (id: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const submitRule = async (categoryId: number) => {
    const draft = draftFor(categoryId);
    if (!draft.pattern.trim() || !ruleDraftReady(draft)) return;
    try {
      await addRule(draft.type, draft.pattern, categoryId, draft.scope);
      setDraft(categoryId, { pattern: "" });
      await onChanged();
    } catch (error) {
      banner.report(error, "rule");
    }
  };
  const submitCategory = async () => {
    if (!newName.trim()) return;
    const used = new Set(meta.categories.map((category) => category.color.toLowerCase()));
    const swatches = meta.palette.swatches;
    const color = swatches.find((swatch) => !used.has(swatch)) ?? swatches[meta.categories.length % swatches.length];
    try {
      const id = await addCategory(newName, color, "unproductive");
      setNewName("");
      setExpanded((current) => new Set(current).add(id));
      await onChanged();
    } catch (error) {
      banner.report(error, "category");
    }
  };
  const setCategoryState = async (category: Category, option: Productivity) => {
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
    // Scrolls itself rather than the page once enough categories are open. The
    // -mr-2/pr-2 pair keeps the scrollbar off the rows without indenting them
    // when there is nothing to scroll.
    <div className="scroll-well -mr-2 flex min-h-0 flex-col overflow-y-auto pr-2">
      {colorMenu !== null && <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setColorMenu(null)} />}
      <p className="mb-4 text-[11px] leading-relaxed text-ink-3">
        Rules classify all matching historical and future activity. When several rules match,
        Website wins, then Window, then App.
      </p>
      <div className="flex flex-col gap-2">
        {meta.categories.map((category) => {
          const open = expanded.has(category.id);
          const state = categoryState(category);
          const stateColorMap = stateColors(meta.palette);
          const locked = isBuiltInIgnored(category);
          const rules = meta.rules.filter((rule) => rule.categoryId === category.id);
          const draft = draftFor(category.id);
          const beginRename = () => { setRenaming(category.id); setRenameDraft(category.name); };
          return (
            <div key={category.id} className="overflow-hidden rounded-[11px] border border-edge bg-surface-2">
              <div className="flex items-center gap-2.5 px-3 py-3 text-xs">
                <button type="button" aria-expanded={open} aria-controls={`category-rules-${category.id}`} aria-label={`${open ? "Collapse" : "Expand"} ${category.name} rules`} onClick={() => toggle(category.id)} className="flex h-6 w-6 items-center justify-center rounded-md text-[10px] text-ink-3 hover:bg-surface-3 hover:text-ink-2"><span className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}>▶</span></button>
                <button
                  type="button"
                  title="Change color"
                  aria-label={`Change color of ${category.name}`}
                  className="block h-3 w-3 shrink-0 rounded hover:shadow-[0_0_0_2px_var(--color-edge-2)]"
                  style={{ backgroundColor: category.color }}
                  onClick={(event) => {
                    if (colorMenu?.id === category.id) return setColorMenu(null);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setColorMenu({
                      id: category.id,
                      left: Math.min(rect.left, window.innerWidth - SWATCH_MENU_WIDTH - 8),
                      top: rect.bottom + 6,
                    });
                  }}
                />
                {/* Double-click renames; the expanded footer keeps a labeled
                    Rename button, because a double-click is invisible to anyone
                    working from the keyboard. */}
                {renaming === category.id ? (
                  <input autoFocus value={renameDraft} aria-label={`Rename ${category.name}`} onChange={(event) => setRenameDraft(event.target.value)} onBlur={() => void saveRename(category)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(category); else if (event.key === "Escape") setRenaming(null); }} className="w-44 rounded-md border border-edge bg-surface px-1.5 py-0.5 text-xs font-semibold outline-none focus:border-accent/60" />
                ) : (
                  <span
                    className={`font-semibold ${locked ? "" : "cursor-text"}`}
                    title={locked ? "The built-in Ignored category cannot be renamed" : "Double-click to rename"}
                    onDoubleClick={locked ? undefined : beginRename}
                  >
                    {category.name}
                  </span>
                )}
                <span className="flex-1" />
                <span className="w-[112px] shrink-0">
                  <MenuSelect
                    variant="bare"
                    size="compact"
                    align="end"
                    className="w-full capitalize"
                    value={state}
                    onChange={(option) => void setCategoryState(category, option as Productivity)}
                    disabled={locked}
                    title={locked ? "The built-in Ignored category is the one ignore mechanism" : `Set how ${category.name} counts`}
                    label={`How ${category.name} counts`}
                    // A category left over from when "ignored" was a state here
                    // keeps showing it, via the placeholder, until one of the
                    // three assignable states is chosen.
                    placeholder={<><CategoryDot color={stateColorMap[state]} />{state}</>}
                    header={state === "ignored" ? "Ignored is no longer a category state. Pick one to bring this category back into Insights." : undefined}
                    options={ASSIGNABLE_STATES.map((option) => ({
                      value: option,
                      label: option,
                      dot: stateColorMap[option],
                    }))}
                  />
                </span>
                <span className="w-[64px] text-right text-[10.5px] text-ink-3">{rules.length} {rules.length === 1 ? "rule" : "rules"}</span>
              </div>
              {open && (
                <div id={`category-rules-${category.id}`} className="ml-[46px] border-t border-edge/50 px-3 py-3">
                  {/* A category with thirty rules should not push the ones
                      below it off the screen: past a few rows the list becomes
                      its own quiet scroll well. */}
                  <div className="scroll-well flex max-h-[220px] flex-col gap-1.5 overflow-y-auto pr-2">
                    {rules.map((rule) => (
                      <div key={rule.id} className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1 text-[11.5px] hover:bg-white/[.028]">
                        <span className="flex w-[74px] shrink-0 items-center gap-1.5 text-[9.5px] uppercase tracking-[.04em] text-ink-3">
                          <RuleKindGlyph matchType={rule.matchType} />
                          {RULE_LABELS[rule.matchType]}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>{rule.pattern}</span>
                        {/* Only Window rules can be scoped, and an unscoped one
                            says nothing worth a chip — the absence is the
                            default reading. */}
                        {rule.matchType === "title" && rule.scope && rule.scope !== ANY_APP && (
                          <span
                            className="shrink-0 rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] text-ink-3"
                            title={rule.scope === BROWSER_SCOPE
                              ? "Only matches windows in a browser."
                              : `Only matches windows belonging to ${rule.scope}.`}
                          >
                            {rule.scope === BROWSER_SCOPE ? "browsers" : rule.scope}
                          </span>
                        )}
                        {applied !== null && !applied.has(rule.id) && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] text-ink-3" title="Nothing in your history has ever matched this rule.">unused</span>}
                        <RemoveButton label={`Delete ${RULE_LABELS[rule.matchType]} rule ${rule.pattern}`} onClick={() => void removeRule(rule.id)} />
                      </div>
                    ))}
                    {rules.length === 0 && <p className="py-1 text-[11px] italic text-ink-3">No rules yet — add one below.</p>}
                  </div>
                  <div className="mt-3 border-t border-edge/40 pt-3">
                    <div className="flex items-center gap-2">
                      <span className="flex rounded-lg border border-edge bg-surface p-0.5">{(["domain", "title", "process"] as MatchType[]).map((type) => <button key={type} type="button" className={`rounded-md px-2 py-1 text-[10.5px] ${draft.type === type ? "bg-surface-3 text-ink-2" : "text-ink-3 hover:text-ink-2"}`} onClick={() => setDraft(category.id, { type })}>{RULE_LABELS[type]}</button>)}</span>
                      <input value={draft.pattern} onChange={(event) => setDraft(category.id, { pattern: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void submitRule(category.id); }} placeholder={draft.type === "domain" ? "example.com" : draft.type === "title" ? "words to match…" : "example.exe"} className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-ink-3 focus:border-accent/60" />
                      <Button variant="primary" disabled={!draft.pattern.trim() || !ruleDraftReady(draft)} onClick={() => void submitRule(category.id)}>Add rule</Button>
                    </div>
                    {/* Only Window rules take a scope, and only they need one:
                        the other two already name what they match. Typed rather
                        than picked from a list of apps, because the rule should
                        be able to name a program that has not been recorded
                        yet. */}
                    {draft.type === "title" && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="shrink-0 text-[10.5px] text-ink-3">Applies to</span>
                        <span className="flex rounded-lg border border-edge bg-surface p-0.5">
                          {([
                            [ANY_APP, "Any app"],
                            [BROWSER_SCOPE, "Browsers"],
                          ] as const).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              className={`rounded-md px-2 py-1 text-[10.5px] ${draft.scope === value ? "bg-surface-3 text-ink-2" : "text-ink-3 hover:text-ink-2"}`}
                              onClick={() => setDraft(category.id, { scope: value })}
                            >
                              {label}
                            </button>
                          ))}
                          <button
                            type="button"
                            className={`rounded-md px-2 py-1 text-[10.5px] ${draft.scope !== ANY_APP && draft.scope !== BROWSER_SCOPE ? "bg-surface-3 text-ink-2" : "text-ink-3 hover:text-ink-2"}`}
                            onClick={() => setDraft(category.id, { scope: SCOPE_PENDING })}
                          >
                            One app
                          </button>
                        </span>
                        {draft.scope !== ANY_APP && draft.scope !== BROWSER_SCOPE && (
                          <input
                            value={draft.scope === SCOPE_PENDING ? "" : draft.scope}
                            onChange={(event) => setDraft(category.id, { scope: event.target.value || SCOPE_PENDING })}
                            placeholder="obsidian.exe"
                            className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-ink-3 focus:border-accent/60"
                          />
                        )}
                      </div>
                    )}
                    <p className="mt-2 text-[10.5px] text-ink-3">
                      {RULE_HELP[draft.type]}
                      {draft.type === "domain" && " Website rules require a supported browser and detected website information."}
                      {draft.type === "title" && (meta.settings.record_window_titles === "1"
                        ? " Window title capture is enabled."
                        : " Future window title capture is off; existing stored titles can still match.")}
                    </p>
                  </div>
                  {/* Deleting a category cascades over its rules, so it gets
                      words rather than an icon — destructive weight should
                      scale with blast radius. */}
                  <div className="mt-3 flex justify-end gap-2 border-t border-edge/40 pt-3">
                    <Button
                      disabled={locked}
                      title={locked ? "The built-in Ignored category cannot be renamed" : undefined}
                      onClick={beginRename}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="danger"
                      disabled={locked}
                      title={locked ? "The built-in Ignored category cannot be deleted" : undefined}
                      onClick={() => void removeCategory(category, rules.length)}
                    >
                      Delete category…
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-edge/50 pt-4"><input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitCategory(); }} placeholder="New category name" className="w-56 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60" /><Button variant="primary" disabled={!newName.trim()} onClick={() => void submitCategory()}>+ Add category</Button></div>
      {colorMenu !== null && createPortal(
        <span
          style={{ left: colorMenu.left, top: colorMenu.top, width: SWATCH_MENU_WIDTH }}
          className="menu-pop fixed z-50 grid grid-cols-5 gap-2 rounded-[11px] border border-edge-2 bg-surface-2 p-2.5 shadow-[0_12px_34px_rgba(0,0,0,.5)]"
        >
          {meta.palette.swatches.map((swatch) => {
            const category = meta.categories.find((item) => item.id === colorMenu.id);
            return (
              <button
                key={swatch}
                type="button"
                aria-label={`Use color ${swatch}`}
                className={`h-4 w-4 rounded hover:shadow-[0_0_0_2px_var(--color-ink-3)] ${swatch === category?.color.toLowerCase() ? "shadow-[0_0_0_2px_var(--color-ink-2)]" : ""}`}
                style={{ backgroundColor: swatch }}
                onClick={() => {
                  setColorMenu(null);
                  if (category) void setCategoryColor(category, swatch);
                }}
              />
            );
          })}
        </span>,
        document.body,
      )}
    </div>
  );
}
