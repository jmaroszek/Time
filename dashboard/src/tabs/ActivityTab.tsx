import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  Button,
  Card,
  CategoryDot,
  Checkbox,
  FloatingTooltip,
  MenuSelect,
  RemoveButton,
  Spinner,
  type MenuOption,
} from "../components/ui";
import { withAlias } from "../lib/aliases";
import {
  type ActivityClassificationFilter,
  type ActivityDayBucket,
  type ActivityEntityPage,
  type ActivityEntityRuleSlice,
  type ActivityEntitySummary,
  type ActivityQuery,
  type ActivityQueryResult,
  type ActivityTitleGroup,
  type ActivityTitleGroupPage,
  type ActivitySort,
  type ActivitySortDirection,
  type ActivitySource,
  type ActivityTypeFilter,
  type ActivityWindowSort,
} from "../lib/activity";
import { buildActivityExport, type ActivityExportKind } from "../lib/activityExport";
import {
  ANY_APP,
  BROWSER_SCOPE,
  categoryState,
  categoryStateFlags,
  type Category,
  type CategoryState,
  type MatchType,
  type Productivity,
  type Rule,
  type TitleRuleAnchor,
  type TitleRuleMatchMode,
  type TitleRuleScopeKind,
  type TitleRuleSpec,
} from "../lib/classify";
import {
  previewTitleRule,
  suggestTitleRuleCandidates,
  type TitleRuleCandidate,
  type TitleRulePreview,
} from "../lib/titleRuleAnalysis";
import {
  containsVersion,
  normalizeWindowTitle,
  splitWindowTitle,
} from "../lib/titleRules";
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
  updateSetting,
  updateCategory,
  type ActivityDeletePreview,
  type ActivityDeleteRequest,
  type SessionCorrection,
  type TrackingExclusion,
  type TrackingExclusionKind,
} from "../lib/queries";
import { allTimeRange, calendarDays, type Range } from "../lib/time";
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
  title: "Matches normalized text in a stored window title, inside the scope you choose.",
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

/** The panel's own window list is a preview, not an archive — the searched
 *  Windows table is where a long list belongs. Fifty rows put half a screen of
 *  scrolling between the reader and the actions below them, for a list whose
 *  first few entries answer "what did I do in here". */
const PANEL_WINDOW_PAGE = 10;
const PANEL_WINDOW_MORE = 20;

type Setter<T> = (update: (current: T) => T) => void;

/**
 * A deletion waiting to be confirmed.
 *
 * `allHistory` is the same deletion widened past the visible range. It is
 * offered inside the dialog rather than as a second button in the panel,
 * because a scope is only worth choosing next to a preview of what it would
 * remove — and two destructive buttons side by side, differing only in blast
 * radius, is a misclick waiting to happen. Null for a visit selection, which
 * is an explicit list of rows with no range to widen.
 */
type DeleteScope = {
  request: ActivityDeleteRequest;
  /** What is being deleted, on a line of its own. */
  label: string;
  /** The dates it covers, on a second line. Null for a visit selection, which
   *  is a list of rows rather than a span. */
  span: string | null;
  /** Only the request and the dates change when the scope widens; what is
   *  being deleted does not. */
  allHistory: { request: ActivityDeleteRequest; span: string } | null;
};

/** Five swatches to a row, so the grid's width is fixed and can be used to keep
 *  the menu on screen when a category sits near the right edge. */
const SWATCH_MENU_WIDTH = 136;

/** Lets the tab scroll a row into view after the keyboard moved the selection.
 *  Entity ids carry `:` and `.`, which getElementById takes literally. */
function entityRowDomId(entityId: string): string {
  return `activity-row-${entityId}`;
}

/**
 * Where the detail panel goes.
 *
 * The page is a fixed-width column centred in the window, which leaves an equal
 * empty margin down each side. The panel takes the right one. Nothing else on
 * the page moves for it — the table keeps the width it has on every other tab,
 * and the date picker above stays where Insights puts it, which is the whole
 * reason the container is not simply widened.
 *
 * It gives ground in that order as the window narrows: below 1864px the gap
 * between panel and table closes, and below 1832px the panel begins covering
 * the table's right-hand columns rather than squeezing them. That is the
 * deliberate trade — a covered column can be read by closing the panel, while a
 * permanently narrowed table cannot be widened. Laptop-class windows are all in
 * the overlapping band; 1080p and larger desktops are not.
 *
 * `MIN` is the width below which the panel's own content starts wrapping badly;
 * `MAX` is where a line of window title gets too long to scan comfortably.
 */
const PANEL_MIN_WIDTH = 340;
const PANEL_MAX_WIDTH = 620;
/** Between the table and the panel, and between the panel and the window edge. */
const PANEL_GAP = 16;
const PANEL_EDGE = 24;

/**
 * Position and width together, so the two cannot disagree about whether the
 * panel is clear of the table. `overlap` is the measured result of the other
 * two rather than a second calculation of it, and is what decides the shadow —
 * a panel that casts one while floating over nothing reads as a stray sheet.
 */
export function detailPanelBox(viewportWidth: number, cardRight: number): {
  left: number;
  width: number;
  overlap: number;
} {
  const margin = viewportWidth - (cardRight + PANEL_GAP) - PANEL_EDGE;
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, margin));
  // Pinned to the window edge as soon as the margin stops being wide enough,
  // so a panel that no longer fits grows back over the table instead of off
  // the side of the screen.
  const left = Math.min(cardRight + PANEL_GAP, viewportWidth - width - PANEL_EDGE);
  return { left, width, overlap: Math.max(0, cardRight - left) };
}

/** The panel stacks under the table below this, as it always has. */
const PANEL_DOCK_MIN_VIEWPORT = 768;

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

/**
 * A date range on one line. The year is said once when both ends share it, and
 * a range that starts and ends on the same date collapses to that date — a
 * confirmation reads faster when it is not carrying the same four digits twice.
 */
export function formatDateSpan(startSec: number, endSec: number): string {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const sameYear = start.getFullYear() === end.getFullYear();
  if (sameYear && start.getMonth() === end.getMonth() && start.getDate() === end.getDate()) {
    return formatShortDate(endSec);
  }
  const from = sameYear
    ? start.toLocaleDateString([], { month: "short", day: "numeric" })
    : formatShortDate(startSec);
  return `${from} – ${formatShortDate(endSec)}`;
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
  const [windowSort, setWindowSort] = useState<ActivityWindowSort>("seconds");
  const [windowDirection, setWindowDirection] = useState<ActivitySortDirection>("desc");
  const [includeNoise, setIncludeNoise] = useState(false);
  const [entityLimit, setEntityLimit] = useState(ENTITY_PAGE);
  const [windowLimit, setWindowLimit] = useState(WINDOW_PAGE);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [detailSearch, setDetailSearch] = useState("");
  const [detailLimit, setDetailLimit] = useState(PANEL_WINDOW_PAGE);
  const [detailSort, setDetailSort] = useState<ActivityWindowSort>("seconds");
  const [detailDirection, setDetailDirection] = useState<ActivitySortDirection>("desc");
  const [selectedWindow, setSelectedWindow] = useState<ActivityTitleGroup | null>(null);
  // Visit selection belongs to a detail surface. The compact search table only
  // discovers a Window; it never silently turns one row into hundreds of
  // selected sessions.
  const [panelSessionIds, setPanelSessionIds] = useState<Set<number>>(() => new Set());
  const [deleteScope, setDeleteScope] = useState<DeleteScope | null>(null);
  const [excludeScope, setExcludeScope] = useState<{
    kind: TrackingExclusionKind;
    pattern: string;
    label: string;
  } | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [ruleDraft, setRuleDraft] = useState<ActivityTitleGroup | null>(null);

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
    windowSort,
    windowDirection,
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
    detailSort,
    detailDirection,
  }), [
    range.start,
    range.end,
    deferredSearch,
    typeFilter,
    classificationFilter,
    sort,
    direction,
    windowSort,
    windowDirection,
    meta.noisePolicy,
    includeNoise,
    entityLimit,
    windowLimit,
    selectedEntityId,
    detailSearch,
    detailLimit,
    detailSort,
    detailDirection,
  ]);
  const analyzed = useActivityModel(source, query);
  const result = analyzed.result;
  const currentWindow = useMemo(() => {
    if (!selectedWindow || !result) return selectedWindow;
    // Entity detail groups are complete; a global title-search group can be a
    // subset when the query matches only one cosmetic spelling.
    return result.detailGroups.rows.find((group) => group.key === selectedWindow.key)
      ?? result.windowMatches?.rows.find((group) => group.key === selectedWindow.key)
      ?? selectedWindow;
  }, [result, selectedWindow]);

  useEffect(() => {
    setEntityLimit(ENTITY_PAGE);
    setWindowLimit(WINDOW_PAGE);
  }, [deferredSearch, typeFilter, classificationFilter, range.start, range.end]);

  useEffect(() => {
    if (!classificationFilter.startsWith("category:")) return;
    const categoryId = Number(classificationFilter.slice("category:".length));
    if (!meta.categories.some((category) => category.id === categoryId)) {
      setClassificationFilter("all");
    }
  }, [classificationFilter, meta.categories]);

  // Only the panel's own ticks are cleared here. A selection is about rows a
  // reader can see, and opening a different entity replaces every row in the
  // panel — but none of the ones in the list beside it.
  useEffect(() => {
    setDetailSearch("");
    setDetailLimit(PANEL_WINDOW_PAGE);
    setPanelSessionIds(new Set());
  }, [selectedEntityId]);

  useEffect(() => {
    setPanelSessionIds(new Set());
  }, [selectedWindow?.key]);

  useEffect(() => {
    setDetailLimit(PANEL_WINDOW_PAGE);
    setPanelSessionIds(new Set());
  }, [detailSearch, detailSort, detailDirection]);

  const dialogOpen = deleteScope !== null
    || excludeScope !== null
    || ruleDraft !== null
    || editingSessionId !== null;
  const catalogRows = result?.catalog.rows;

  /**
   * The detail panel is an inspector, not a dialog, so the list behind it stays
   * live — and the arrows that would have scrolled that list are worth more
   * spent walking it, which is what triaging a library actually is. Anything
   * with its own arrow behaviour (a field, an open menu) keeps it.
   *
   * Escape dismisses one layer at a time: a Window returns to the app it
   * belongs to, and only then does the panel close. A dialog on top owns
   * Escape outright, or closing it would take the panel underneath with it.
   */
  useEffect(() => {
    if (!selectedEntityId || dialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      const from = event.target as HTMLElement | null;
      if (event.key === "Escape") {
        // An open menu closes itself first; taking the panel with it would
        // punish opening a menu by mistake. Fields stop their own Escape at
        // the source, so anything still arriving here means the panel.
        if (from?.closest("[role='combobox'][aria-expanded='true']")) return;
        event.preventDefault();
        setPanelSessionIds(new Set());
        if (selectedWindow) setSelectedWindow(null);
        else setSelectedEntityId(null);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      // Only the identity list has an order to walk; a Window panel is opened
      // from two different lists and belongs to neither.
      if (selectedWindow) return;
      if (from?.closest("input, textarea, [role='combobox'], [role='listbox']")) return;
      const rows = catalogRows ?? [];
      const at = rows.findIndex((row) => row.id === selectedEntityId);
      const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (at < 0 || !next) return;
      event.preventDefault();
      openEntity(next.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedEntityId, selectedWindow, dialogOpen, catalogRows]);

  // Whichever way the selection moved, the row it landed on has to be visible:
  // walking the list with the arrows is useless if the highlight is offscreen.
  useEffect(() => {
    if (!selectedEntityId) return;
    document.getElementById(entityRowDomId(selectedEntityId))?.scrollIntoView({ block: "nearest" });
  }, [selectedEntityId]);

  // The panel is positioned against the table rather than laid out beside it,
  // so that opening one cannot change the table's width. The page container
  // clips its overflow, which is why this is `fixed` and measured rather than
  // absolutely positioned inside it.
  //
  // Measured in a layout effect, not an ordinary one. Until the measurement
  // lands the panel has no position and renders as an ordinary block in the
  // column — full width, under the table — and with a plain effect the browser
  // painted that frame before the correction arrived. It read as a flash of
  // panel across the middle of the page every time a row was opened. A layout
  // effect runs before paint, so the unpositioned state is never shown.
  const cardRef = useRef<HTMLDivElement>(null);
  const [dock, setDock] = useState<{ style: CSSProperties; overlap: number } | null>(null);
  const panelOpen = view === "library"
    && (currentWindow !== null || (result?.selectedEntity ?? null) !== null);
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || !panelOpen) {
      setDock(null);
      return;
    }
    const measure = () => {
      if (window.innerWidth < PANEL_DOCK_MIN_VIEWPORT) {
        setDock(null);
        return;
      }
      const card = node.getBoundingClientRect();
      const box = detailPanelBox(window.innerWidth, card.right);
      setDock({
        style: {
          position: "fixed",
          top: card.top,
          height: card.height,
          left: box.left,
          width: box.width,
        },
        overlap: box.overlap,
      });
    };
    measure();
    // The card's height moves with the window and with the banner above it,
    // neither of which a resize listener alone would catch.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelOpen]);
  const panelStyle = dock?.style ?? null;
  const overlapping = (dock?.overlap ?? 0) > 0;

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
      // A rule is retroactive and global, and the panel it was set from only
      // shows one date range. Saying so once, on the change itself, beats the
      // standing paragraph that used to warn about it before anything happened.
      const category = meta.categories.find((option) => option.id === categoryId);
      if (category) {
        banner.show(`${entity.displayName} is now ${category.name}, in all history and from now on.`);
      }
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
      banner.show(`Removed the ${entity.kind === "website" ? "Website" : "App"} rule for ${entity.key}.`);
    } catch (error) {
      banner.report(error, "rule");
    }
  };
  const toggle = (set: Setter<Set<number>>) => (id: number) => set((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const togglePanelSession = toggle(setPanelSessionIds);
  /** A Window detail action names the complete group explicitly, so selecting
   *  all includes every represented visit even though only a recent sample is
   *  carried for individual inspection. */
  const toggleAll = (set: Setter<Set<number>>) => (ids: number[]) => set((current) => {
    const next = new Set(current);
    if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
    else for (const id of ids) next.add(id);
    return next;
  });
  const toggleAllPanelSessions = toggleAll(setPanelSessionIds);
  const requestSessionDeletion = (ids: Set<number>) => {
    if (ids.size === 0) return;
    setDeleteScope({
      request: { mode: "sessions", sessionIds: [...ids] },
      label: `${ids.size} selected visit${ids.size === 1 ? "" : "s"}`,
      span: null,
      // Already an explicit list of rows, so there is no range to widen.
      allHistory: null,
    });
  };
  const requestEntityDeletion = (entity: ActivityEntitySummary) => {
    const forRange = (startSec: number, endSec: number): ActivityDeleteRequest => ({
      mode: "entity",
      entityKind: entity.kind,
      entityKey: entity.key,
      startSec,
      endSec,
      browserProcesses,
    });
    // The display name alone. The key beside it repeated the same string for
    // every website and most apps, and a confirmation is read for its shape
    // before its words — a doubled name costs more than the rare case where
    // the two differ.
    // A colon, not quotation marks. The line is a labelled field rather than a
    // sentence quoting a name, and it reads as one now that the key that
    // followed it is gone.
    const named = `${entity.kind === "website" ? "Website" : "App"}: ${entity.displayName}`;
    setDeleteScope({
      request: forRange(range.start.getTime() / 1000, range.end.getTime() / 1000),
      label: named,
      span: formatDateSpan(range.start.getTime() / 1000, (range.end.getTime() - 1) / 1000),
      allHistory: {
        request: forRange(allRange.start.getTime() / 1000, allRange.end.getTime() / 1000),
        span: formatDateSpan(allRange.start.getTime() / 1000, (allRange.end.getTime() - 1) / 1000),
      },
    });
  };
  const historyDeleted = (closeEntity: boolean) => {
    setPanelSessionIds(new Set());
    if (closeEntity) {
      setSelectedWindow(null);
      setSelectedEntityId(null);
    }
  };
  const openEntity = (entityId: string) => {
    setPanelSessionIds(new Set());
    setSelectedWindow(null);
    setSelectedEntityId(entityId);
  };
  const openWindow = (group: ActivityTitleGroup) => {
    setPanelSessionIds(new Set());
    setSelectedEntityId(group.entityId);
    setSelectedWindow(group);
  };
  // The panel describes a row in the Library. Carrying it across to Categories
  // & Rules left it beside a list that could not have opened it.
  const switchView = (next: ActivityView) => {
    setView(next);
    setPanelSessionIds(new Set());
    setSelectedWindow(null);
    setSelectedEntityId(null);
  };

  if (!meta.loaded || (!result && (sessionData.loading || analyzed.refreshing))) return <Spinner />;
  const error = sessionData.error ?? analyzed.error;
  if (error && !result) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const showingExclusions = classificationFilter === "excluded";
  const hasActiveLibraryFilters = typeFilter !== "all" || classificationFilter !== "all";
  const clearLibraryFilters = () => {
    setTypeFilter("all");
    setClassificationFilter("all");
  };
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

      {/* The card is measured, not shrunk. The panel docks against its right
          edge from outside the page container, so opening one leaves the table
          exactly the width it has on every other tab. */}
      <div ref={cardRef} className={`flex min-h-0 ${view === "library" ? "flex-1" : ""}`}>
      {/* One card, whose title is the switcher: a floating control row above it
          left the page reading as two stacked chromes instead of "date picker
          up top, one card below". */}
      {/* Only the Library fills the window. Categories & Rules is a short,
          mostly-folded list, and stretching it to the viewport bought a screen
          of empty card for nothing. It still takes min-h-0, so it sizes to its
          content while staying able to shrink — enough categories opened at
          once then scrolls the card instead of the page. */}
      <Card
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        title={<ViewSwitcher view={view} onView={switchView} />}
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
                      scale={result}
                      sort={sort}
                      direction={direction}
                      onSort={(next) => updateSort(next, sort, direction, setSort, setDirection)}
                      windowSort={windowSort}
                      windowDirection={windowDirection}
                      onWindowSort={(next) => updateWindowSort(
                        next,
                        windowSort,
                        windowDirection,
                        setWindowSort,
                        setWindowDirection,
                      )}
                      selectedEntityId={selectedEntityId}
                      selectedWindowKey={currentWindow?.key ?? null}
                      onSelectEntity={openEntity}
                      onSelectWindow={openWindow}
                      onLoadIdentities={() => setEntityLimit((limit) => limit + ENTITY_PAGE)}
                      onLoadWindows={() => setWindowLimit((limit) => limit + WINDOW_PAGE)}
                      isAllTime={isAllTime}
                      onTryAllTime={onTryAllTime}
                      hasActiveFilters={hasActiveLibraryFilters}
                      onClearFilters={clearLibraryFilters}
                    />
                  ) : (
                    <EntityCatalog
                      page={result.catalog}
                      scale={result}
                      sort={sort}
                      direction={direction}
                      onSort={(next) => updateSort(next, sort, direction, setSort, setDirection)}
                      selectedEntityId={selectedEntityId}
                      onSelect={openEntity}
                      onLoadMore={() => setEntityLimit((limit) => limit + ENTITY_PAGE)}
                      isAllTime={isAllTime}
                      onTryAllTime={onTryAllTime}
                      hasActiveFilters={hasActiveLibraryFilters}
                      onClearFilters={clearLibraryFilters}
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
      </div>

      {currentWindow ? (
        <WindowPanel
          dock={panelStyle}
          overlapping={overlapping}
          group={currentWindow}
          rangeDays={calendarDays(range)}
          selectedSessionIds={panelSessionIds}
          onToggleSession={togglePanelSession}
          onToggleAllSessions={toggleAllPanelSessions}
          onDeleteSelected={() => requestSessionDeletion(panelSessionIds)}
          onEditSession={setEditingSessionId}
          onMakeRule={setRuleDraft}
          onBack={() => {
            setPanelSessionIds(new Set());
            setSelectedWindow(null);
          }}
          onClose={() => {
            setPanelSessionIds(new Set());
            setSelectedWindow(null);
            setSelectedEntityId(null);
          }}
        />
      ) : result?.selectedEntity ? (
        <EntityPanel
          dock={panelStyle}
          overlapping={overlapping}
          entity={result.selectedEntity}
          groups={result.detailGroups}
          usage={result.selectedEntityUsage}
          rangeSeconds={result.totalSeconds}
          rangeDays={calendarDays(range)}
          hasStoredTitles={result.hasStoredTitles}
          detailSearch={detailSearch}
          onDetailSearch={setDetailSearch}
          detailSort={detailSort}
          detailDirection={detailDirection}
          onDetailSort={(nextSort, nextDirection) => {
            setDetailSort(nextSort);
            setDetailDirection(nextDirection);
          }}
          onLoadMore={() => setDetailLimit((limit) => limit + PANEL_WINDOW_MORE)}
          onClose={() => setSelectedEntityId(null)}
          categories={meta.categories}
          rules={meta.rules}
          aliases={meta.aliases}
          onDeleteEntity={() => requestEntityDeletion(result.selectedEntity!)}
          onExclude={() => setExcludeScope({
            kind: result.selectedEntity!.kind === "app" ? "app" : "website",
            pattern: result.selectedEntity!.key,
            label: result.selectedEntity!.displayName,
          })}
          onOpenWindow={openWindow}
          onAssign={(categoryId) => assignEntity(result.selectedEntity!, categoryId)}
          onSaveAlias={(alias) => saveAlias(result.selectedEntity!.key, alias)}
          onRemoveExactRule={() => removeExactRules(result.selectedEntity!)}
        />
      ) : null}

      {deleteScope && (
        <DeleteActivityDialog
          scope={deleteScope}
          onClose={() => setDeleteScope(null)}
          onDeleted={(request) => {
            setDeleteScope(null);
            if (request.mode === "sessions" && currentWindow) {
              const deletedIds = new Set(request.sessionIds);
              if (currentWindow.sessionIds.every((id) => deletedIds.has(id))) {
                setSelectedWindow(null);
              }
            }
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

/**
 * A text filter that can be emptied without selecting its contents.
 *
 * Both of this tab's filters swap out the list beneath them, so both need a way
 * back that is not "select the text and delete it" — Escape, and a trailing ✕
 * for the mouse. They were not sharing one, and only the wider of the two had
 * either. The visible label is optional; the accessible one is not, because a
 * placeholder disappears the moment anything is typed into it.
 */
function ClearableInput({
  value,
  onChange,
  label,
  placeholder,
  leadingIcon = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  leadingIcon?: boolean;
  className?: string;
}) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      {leadingIcon && (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="absolute left-3 top-2.5 h-3.5 w-3.5 text-ink-3">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
        </svg>
      )}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            // Stopped here, or the panel's own Escape closes the whole thing
            // out from under someone who only meant to clear a filter.
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        className={`w-full rounded-[9px] border border-edge bg-surface-2 py-2 pr-8 text-xs outline-none placeholder:text-ink-3 focus:border-accent/60 ${leadingIcon ? "pl-9" : "pl-2.5"}`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          title={`Clear ${label.toLowerCase()}`}
          className="absolute right-2 top-1.5 rounded p-1 text-ink-3 hover:bg-white/[.06] hover:text-ink-2"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
          <span className="sr-only">Clear {label.toLowerCase()}</span>
        </button>
      )}
    </label>
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
          <ClearableInput
            value={search}
            onChange={onSearch}
            label="Search activity"
            placeholder="Search apps, websites, and windows…"
            leadingIcon
            className="min-w-[240px] flex-1"
          />
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

function updateWindowSort(
  next: ActivityWindowSort,
  current: ActivityWindowSort,
  direction: ActivitySortDirection,
  setSort: (sort: ActivityWindowSort) => void,
  setDirection: (direction: ActivitySortDirection) => void,
): void {
  if (next === current) setDirection(direction === "asc" ? "desc" : "asc");
  else {
    setSort(next);
    setDirection(next === "title" ? "asc" : "desc");
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

type SummaryTableSort = "label" | "seconds" | "days" | "lastSeen";

interface SummaryTableBadge {
  label: string;
  title: string;
  tone?: "muted" | "accent";
}

interface SummaryTableRow {
  key: string;
  /** DOM id, for callers that need to scroll a row into view from outside the
   *  table — the identity list does, once the arrow keys can move its
   *  selection while the reader's hands are nowhere near it. */
  anchorId?: string;
  primary: ReactNode;
  primaryLabel: string;
  primaryTitle?: string;
  metadata: ReactNode;
  badges: SummaryTableBadge[];
  seconds: number;
  daysSeen: number;
  lastSeen: number;
  selected: boolean;
  openLabel: string;
  onOpen: () => void;
}

function SummarySortHeading({
  label,
  field,
  active,
  direction,
  className = "",
  onSort,
}: {
  label: string;
  field: SummaryTableSort;
  active: boolean;
  direction: ActivitySortDirection;
  className?: string;
  onSort: (field: SummaryTableSort) => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : undefined}
      className={`pb-2 font-medium ${className}`}
    >
      <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-ink-2">
        {label}{active && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

/**
 * Both Activity summaries deliberately share this renderer. The columns are a
 * reading rhythm, not a property of either data source: identity or title,
 * relative time, exact time, recurrence, recency. Keeping their widths and
 * cell spacing here means the two tables line up exactly and cannot drift as
 * either row gains new metadata.
 */
function SummaryTable({
  rows,
  tableLabel,
  scale,
  sort,
  direction,
  onSort,
  headOffset,
}: {
  rows: SummaryTableRow[];
  tableLabel: string;
  scale: BarScale;
  sort: SummaryTableSort;
  direction: ActivitySortDirection;
  onSort: (field: SummaryTableSort) => void;
  headOffset?: string;
}) {
  return (
    <table aria-label={tableLabel} className="w-full min-w-[680px] table-fixed text-xs">
      {/* Sticky via a shadow, not a border: a collapsed table's borders do not
          travel with a stuck header row. */}
      <StickyHead offset={headOffset}>
        <tr className="text-left text-[10.5px] text-ink-3">
          <SummarySortHeading
            label="Name"
            field="label"
            active={sort === "label"}
            direction={direction}
            onSort={onSort}
            className="w-[27%] text-left"
          />
          {/* The bar draws what Time already sorts, so it has no independent
              heading or sort state. */}
          <th scope="col" className="w-[37%] pb-2">
            <span className="sr-only">Time relative to the busiest result</span>
          </th>
          <SummarySortHeading
            label="Time"
            field="seconds"
            active={sort === "seconds"}
            direction={direction}
            onSort={onSort}
            className="w-[9%] text-right"
          />
          {/* Centering keeps a one- or two-digit count from clinging to either
              adjacent measure. The offset balances Last seen's right edge. */}
          <SummarySortHeading
            label="Days seen"
            field="days"
            active={sort === "days"}
            direction={direction}
            onSort={onSort}
            className="w-[15%] pl-8 text-center"
          />
          <SummarySortHeading
            label="Last seen"
            field="lastSeen"
            active={sort === "lastSeen"}
            direction={direction}
            onSort={onSort}
            className="w-[12%] text-right"
          />
        </tr>
      </StickyHead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            id={row.anchorId}
            // The panel no longer covers the list, so the open row is on screen
            // beside it and has to be told apart from the one under the cursor.
            // A second gray could not; the interface's own colour can.
            aria-current={row.selected ? "true" : undefined}
            className={`cursor-pointer border-b border-edge/40 transition-colors hover:bg-white/[.035] ${row.selected ? "bg-accent/[.09]" : ""}`}
            onClick={row.onOpen}
          >
            <td className="py-2.5 pr-4">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {/* The row is clickable for the mouse, but the keyboard needs
                      a real control to land on. */}
                  <button
                    type="button"
                    title={row.primaryTitle}
                    aria-label={`${row.primaryLabel} — ${row.openLabel}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      row.onOpen();
                    }}
                    className="min-w-0 truncate rounded-sm text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                  >
                    {row.primary}
                  </button>
                  {row.badges.map((badge) => (
                    <RowTag key={`${badge.label}:${badge.title}`} tone={badge.tone} title={badge.title}>
                      {badge.label}
                    </RowTag>
                  ))}
                </span>
                <span className="flex min-w-0 items-center gap-[5px] text-[10px] leading-[1.4] text-ink-3">
                  {row.metadata}
                </span>
              </span>
            </td>
            <td className="py-2.5 pr-4">
              <ShareBar seconds={row.seconds} maxSeconds={scale.maxSeconds} totalSeconds={scale.totalSeconds} />
            </td>
            <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(row.seconds)}</td>
            <td className="py-2.5 pl-8 text-center tabular-nums text-ink-3">{row.daysSeen}</td>
            <td className="py-2.5 text-right tabular-nums text-ink-3">{formatLastSeen(row.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  hasActiveFilters,
  onClearFilters,
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
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  if (page.total === 0) {
    return (
      <NoResults
        isAllTime={isAllTime}
        onTryAllTime={onTryAllTime}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={onClearFilters}
      />
    );
  }
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
 * What remains separate is worth separating: identities and Windows are both
 * compact discovery rows, but answer different searches and open different
 * detail modes. Visit selection and deletion stay out of both tables.
 */
function SearchResults({
  identities,
  windows,
  search,
  scale,
  sort,
  direction,
  onSort,
  windowSort,
  windowDirection,
  onWindowSort,
  selectedEntityId,
  selectedWindowKey,
  onSelectEntity,
  onSelectWindow,
  onLoadIdentities,
  onLoadWindows,
  isAllTime,
  onTryAllTime,
  hasActiveFilters,
  onClearFilters,
}: {
  identities: ActivityEntityPage;
  windows: ActivityTitleGroupPage;
  search: string;
  scale: BarScale;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  windowSort: ActivityWindowSort;
  windowDirection: ActivitySortDirection;
  onWindowSort: (field: ActivityWindowSort) => void;
  selectedEntityId: string | null;
  selectedWindowKey: string | null;
  onSelectEntity: (id: string) => void;
  onSelectWindow: (group: ActivityTitleGroup) => void;
  onLoadIdentities: () => void;
  onLoadWindows: () => void;
  isAllTime: boolean;
  onTryAllTime: () => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  if (identities.total === 0 && windows.total === 0) {
    return (
      <NoResults
        search={search}
        isAllTime={isAllTime}
        onTryAllTime={onTryAllTime}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={onClearFilters}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {identities.total > 0 && (
        <ResultGroup
          title="Apps and websites"
          summary={[
            countNoun(identities.total, "result"),
            identities.apps > 0 ? countNoun(identities.apps, "app") : null,
            identities.websites > 0 ? countNoun(identities.websites, "website") : null,
          ].filter((part): part is string => part !== null).join(" · ")}
        >
          <EntityTable
            rows={identities.rows}
            scale={scale}
            sort={sort}
            direction={direction}
            onSort={onSort}
            selectedEntityId={selectedEntityId}
            onSelect={onSelectEntity}
            headOffset="top-12"
          />
          {identities.rows.length < identities.total && (
            <LoadMore shown={identities.rows.length} total={identities.total} onClick={onLoadIdentities} />
          )}
        </ResultGroup>
      )}
      {windows.total > 0 && (
        <ResultGroup
          title="Windows"
          summary={`${countNoun(windows.total, "result")} · ${countNoun(windows.sessionTotal, "visit")}`}
        >
          <WindowGroupTable
            rows={windows.rows}
            search={search}
            scale={scale}
            sort={windowSort}
            direction={windowDirection}
            onSort={onWindowSort}
            selectedKey={selectedWindowKey}
            onSelect={onSelectWindow}
          />
          {/* Paging belongs to the list, so it stays against the table it extends. */}
          {windows.rows.length < windows.total && (
            <LoadMore shown={windows.rows.length} total={windows.total} onClick={onLoadWindows} />
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
 * A true text-sm heading with stronger weight and ink keeps the section label
 * visibly above the compact table headings beneath it. Labeled totals sit on a
 * second line: unlike bare inline numbers, each quantity states what it counts.
 */
function countNoun(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function ResultGroup({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="sticky top-0 z-20 flex h-12 items-center bg-surface">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-1">{title}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-[10.5px] tabular-nums leading-[1.4] text-ink-3">
            <span>{summary}</span>
          </div>
        </div>
      </div>
      <div className="pt-1">{children}</div>
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
  const summarySort: SummaryTableSort = sort === "name" ? "label" : sort;
  const summaryRows: SummaryTableRow[] = rows.map((entity) => {
    const badges: SummaryTableBadge[] = [];
    if (entity.isNew) {
      badges.push({
        label: "New",
        title: "First seen in all of your history inside this date range.",
        tone: "accent",
      });
    }
    if (entity.noise) {
      badges.push({
        label: entity.noise === "utility" ? "Utility" : "Rare",
        title: entity.noise === "utility"
          ? "Looks like an installer, driver, or local file — normally hidden from this list."
          : "Seen briefly and rarely across all history — normally hidden from this list.",
      });
    }
    return {
      key: entity.id,
      anchorId: entityRowDomId(entity.id),
      primary: entity.displayName,
      primaryLabel: entity.displayName,
      primaryTitle: entity.key,
      metadata: (
        <>
          <ClassificationLabel entity={entity} />
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="shrink-0 capitalize">{entity.kind}</span>
        </>
      ),
      badges,
      seconds: entity.seconds,
      daysSeen: entity.daysSeen,
      lastSeen: entity.lastSeen,
      selected: selectedEntityId === entity.id,
      openLabel: "open details",
      onOpen: () => onSelect(entity.id),
    };
  });

  return (
    <div>
      <SummaryTable
        rows={summaryRows}
        tableLabel="Apps and websites"
        scale={scale}
        sort={summarySort}
        direction={direction}
        onSort={(field) => onSort(field === "label" ? "name" : field)}
        headOffset={headOffset}
      />
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
 * case also keeps them in the app's voice, and the shape matches the panel's
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
      // normal-case is defended, not decorative: the panel's eyebrow row is
      // uppercase, and a tag inheriting that loses the sentence case above.
      className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium normal-case leading-[1.4] ${styles}`}
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
 * One row per distinct normalized full title, carrying how many times it was
 * returned to and how long that came to. The tracker's own unit — an
 * uninterrupted spell in the foreground — is the wrong thing to hand someone:
 * half of a real database's rows last under ten seconds and carry a few percent
 * of its time, so a search answered row by row buries what was asked for under
 * hundreds of fragments of the same window. The table stays a discovery list;
 * selecting a row moves interval-level work into the Window panel.
 */
function windowGroupClassification(group: ActivityTitleGroup): { label: string; detail: string } {
  if (group.allIgnored) {
    return {
      label: "Ignored",
      detail: group.mixed ? "Visits use different ignored categories" : group.categoryName ?? "Ignored",
    };
  }
  if (group.mixed) {
    return { label: "Mixed", detail: "Visits use different classifications" };
  }
  const label = group.categoryName ?? "Uncategorized";
  if (group.provenanceMixed) return { label, detail: "Varies across visits" };
  if (group.classificationSource === "session_override") {
    return { label, detail: "Manual correction" };
  }
  if (group.winningRuleType && group.winningRulePattern) {
    return {
      label,
      detail: `${RULE_LABELS[group.winningRuleType]} rule · ${group.winningRulePattern}`,
    };
  }
  return { label, detail: "No matching rule" };
}

function WindowGroupTable({
  rows,
  search,
  scale,
  sort,
  direction,
  onSort,
  selectedKey,
  onSelect,
}: {
  rows: ActivityTitleGroup[];
  search: string;
  scale: BarScale;
  sort: ActivityWindowSort;
  direction: ActivitySortDirection;
  onSort: (field: ActivityWindowSort) => void;
  selectedKey: string | null;
  onSelect: (group: ActivityTitleGroup) => void;
}) {
  const summarySort: SummaryTableSort = sort === "title" ? "label" : sort;
  const summaryRows: SummaryTableRow[] = rows.map((group) => {
    const classification = windowGroupClassification(group);
    return {
      key: group.key,
      primary: <MatchedTitle title={group.title} search={search} />,
      primaryLabel: group.title,
      primaryTitle: group.title,
      metadata: (
        <>
          <span className="shrink-0">{classification.label}</span>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="min-w-0 truncate" title={group.entityKey}>{group.displayName}</span>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="shrink-0">{group.entityKind === "website" ? "Website" : "App"}</span>
        </>
      ),
      badges: group.isNew
        ? [{
            label: "New",
            title: "First seen in all of your history inside this date range.",
            tone: "accent" as const,
          }]
        : [],
      seconds: group.seconds,
      daysSeen: group.daysSeen,
      lastSeen: group.lastSeen,
      selected: selectedKey === group.key,
      openLabel: "open Window details",
      onOpen: () => onSelect(group),
    };
  });

  return (
    <div>
      <SummaryTable
        rows={summaryRows}
        tableLabel="Windows"
        scale={scale}
        sort={summarySort}
        direction={direction}
        onSort={(field) => onSort(field === "label" ? "title" : field)}
        headOffset="top-12"
      />
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
          Showing the {group.sessions.length} most recent of {group.sessionCount} visits.
          Select all visits includes the complete group.
        </span>
      )}
    </div>
  );
}

/** Characters of the title kept ahead of the match, enough to read it in
 *  context without pushing the match itself back out of view. */
const MATCH_LEAD = 30;

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
            Nothing is excluded. Open an app or website and choose “Do not track” to add one.
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
  hasActiveFilters,
  onClearFilters,
}: {
  isAllTime: boolean;
  onTryAllTime: () => void;
  search?: string;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  const message = search
    ? hasActiveFilters
      ? <>No matches for &ldquo;{search}&rdquo; with these filters</>
      : <>No matches for &ldquo;{search}&rdquo; in this range</>
    : hasActiveFilters
      ? <>No activity matches these filters</>
      : <>No activity found in this range</>;
  return (
    <div className="flex h-36 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-3">
      <span className="max-w-[42ch] truncate">{message}</span>
      <span className="flex items-center gap-1.5">
        {hasActiveFilters && (
          <button type="button" onClick={onClearFilters} className="text-xs text-accent hover:text-accent/80">
            Clear filters
          </button>
        )}
        {hasActiveFilters && !isAllTime && <span aria-hidden="true">·</span>}
        {!isAllTime && (
          <button type="button" onClick={onTryAllTime} className="text-xs text-accent hover:text-accent/80">
            Try all time
          </button>
        )}
      </span>
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
 * The shell both Activity panels sit in.
 *
 * It is an inspector, not a dialog: no scrim, no focus trap, and the list it
 * was opened from stays live behind — which is the whole point, because working
 * through a library means moving down it. Escape and the arrows are wired at
 * the tab, the only level that knows the row order.
 *
 * The two panels were duplicating this markup character for character, down to
 * the shadow. That is exactly the drift the shared SummaryTable exists to stop
 * one table over, so it is stopped the same way here.
 */
function DetailPanel({
  label,
  dock,
  overlapping,
  eyebrow,
  heading,
  subtitle,
  onBack,
  backLabel,
  onClose,
  closeLabel,
  children,
}: {
  /** Names the landmark. A string rather than a reference to the heading,
   *  because the heading is an editable field while a rename is in progress
   *  and would name the panel by a half-typed draft. */
  label: string;
  /** Measured position in the page's right margin. Null on a window too narrow
   *  to dock into, where the panel falls back to stacking under the table. */
  dock: CSSProperties | null;
  /** True when the margin could not hold the panel and it is floating over the
   *  table's right-hand columns. Only then does it need to cast a shadow. */
  overlapping: boolean;
  eyebrow: ReactNode;
  heading: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      style={dock ?? undefined}
      className={`panel-in flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-edge bg-surface ${
        dock
          ? `z-30 ${overlapping ? "shadow-[0_18px_48px_rgba(0,0,0,.5)]" : ""}`
          : "max-h-[60vh] w-full shrink-0"
      }`}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-edge px-5 py-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={backLabel}
            aria-label={backLabel}
            className="mt-0.5 rounded-md px-2 py-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
          >
            ←
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] uppercase tracking-[.05em] text-ink-3">
            {eyebrow}
          </div>
          {heading}
          {subtitle}
        </div>
        <button
          type="button"
          onClick={onClose}
          title={`${closeLabel} (Esc)`}
          aria-label={closeLabel}
          className="rounded-md px-2 py-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          ✕
        </button>
      </div>
      {/* The top padding belongs to the content, not the scroll box. A sticky
          heading with `top: 0` pins to the scroll container's *content* box, so
          a padded container parks it that far down the scrollport and leaves a
          band above it — exactly 20px of it — through which the rows below
          scrolled in full view. Horizontal padding is unaffected and stays
          here, where the sticky headings' -mx-5 bleed still relies on it. */}
      <div className="scroll-well min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="pt-5">{children}</div>
      </div>
    </aside>
  );
}

/** A panel section. The heading level is fixed here so the two panels cannot
 *  drift apart on the one thing a screen reader navigates them by. */
function PanelSection({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // 13px, not 12: these are the panel's top-level markers and sit a step
    // under the card titles' 14px rather than level with body copy. The gap
    // grew with them, or the sections read as one run of text.
    <section className={`mt-6 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * The category a window row is worth labelling with.
 *
 * Inside one app's panel nearly every window resolves the way the app does, so
 * printing "AI" against each of Claude's windows repeats a fact the
 * Classification section states once, twenty rows running. Null means "same as
 * the app, say nothing", which turns the label into a signal: it shows up only
 * where a Window rule or a correction has pulled one window somewhere else.
 *
 * The baseline is null when the entity has no single category of its own, and
 * then every row is worth labelling — that is exactly the case where they
 * differ from each other.
 */
export function windowRowCategory(
  group: Pick<ActivityTitleGroup, "mixed" | "categoryId" | "categoryName">,
  baselineCategoryId: number | null,
): string | null {
  if (group.mixed) return "Mixed";
  if (baselineCategoryId !== null && group.categoryId === baselineCategoryId) return null;
  return group.categoryName ?? "Uncategorized";
}

/** One Window in an entity's list. Visit-level actions live in the Window
 * panel, so this row has one verb and cannot expand the list in place. */
function PanelWindowRow({
  group,
  search,
  maxSeconds,
  totalSeconds,
  category,
  onOpen,
}: {
  group: ActivityTitleGroup;
  search: string;
  maxSeconds: number;
  totalSeconds: number;
  /** Null when it matches the app's own, and so is not worth the words. */
  category: string | null;
  onOpen: (group: ActivityTitleGroup) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(group)}
      className="w-full rounded-lg border border-edge/60 px-2.5 py-2 text-left text-[11.5px] outline-none transition-colors hover:border-edge-2 hover:bg-white/[.025] focus-visible:border-accent/60"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-ink-2">
          {/* Title capture can be switched on part way through a history, so
              one app can hold both kinds of row. A bare em dash left the
              untitled one looking like a rendering fault rather than a fact. */}
          {group.title
            ? <MatchedTitle title={group.title} search={search} />
            : <span className="italic text-ink-3">No title recorded</span>}
        </span>
        {group.isNew && (
          <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
        )}
        {/* The row opens something. Without this it read as a static summary,
            and the only hint otherwise was the cursor. */}
        <Chevron open={false} />
      </span>
      {/* The same bar the library table draws, against the heaviest window this
          app has rather than the heaviest row on screen — so it does not
          rescale when the list is re-sorted or extended. */}
      <span className="mt-1.5 block">
        <ShareBar seconds={group.seconds} maxSeconds={maxSeconds} totalSeconds={totalSeconds} />
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-ink-3">
        <span className="tabular-nums">{fmtDuration(group.seconds)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{countNoun(group.sessionCount, "visit")}</span>
        {category !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{category}</span>
          </>
        )}
        <span className="ml-auto shrink-0 tabular-nums">{formatLastSeen(group.lastSeen)}</span>
      </span>
    </button>
  );
}

function WindowPanel({
  dock,
  overlapping,
  group,
  rangeDays,
  selectedSessionIds,
  onToggleSession,
  onToggleAllSessions,
  onDeleteSelected,
  onEditSession,
  onMakeRule,
  onBack,
  onClose,
}: {
  dock: CSSProperties | null;
  overlapping: boolean;
  group: ActivityTitleGroup;
  /** Calendar days the range spans, so "days seen" has a denominator. */
  rangeDays: number;
  selectedSessionIds: Set<number>;
  onToggleSession: (id: number) => void;
  onToggleAllSessions: (ids: number[]) => void;
  onDeleteSelected: () => void;
  onEditSession: (id: number) => void;
  onMakeRule: (group: ActivityTitleGroup) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const classification = windowGroupClassification(group);
  const allSelected = group.sessionIds.every((id) => selectedSessionIds.has(id));
  const exceptionalProvenance = group.mixed
    || group.provenanceMixed
    || group.classificationSource === "session_override"
    || group.winningRuleType === "title";
  return (
    <DetailPanel
      dock={dock}
      overlapping={overlapping}
      label={`Window details: ${group.title || "no title recorded"}`}
      eyebrow={
        <>
          <span>Window</span>
          {group.isNew && (
            <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
          )}
        </>
      }
      heading={
        <h2 className="break-words text-lg font-semibold">
          {group.title || <span className="italic text-ink-3">No title recorded</span>}
        </h2>
      }
      subtitle={
        <p className="truncate text-[11px] text-ink-3" title={group.entityKey}>
          {group.displayName} · {group.entityKind === "website" ? "Website" : "App"} · <span className="font-mono">{group.entityKey}</span>
        </p>
      }
      onBack={onBack}
      backLabel={`Back to ${group.displayName} details`}
      onClose={onClose}
      closeLabel="Close Window details"
    >
      {/* Two across, not four. In a panel this narrow a quarter is about 100px,
          which "Today, 4:46 PM" does not fit into — the tile that most wanted
          the friendlier wording was the one being truncated by it. */}
      <div className="grid grid-cols-2 gap-3">
        <DetailMetric
          label="Time in range"
          value={fmtDuration(group.seconds)}
          hint={`Every visit to this window across the ${countNoun(rangeDays, "day")} shown, added up.`}
        />
        <DetailMetric
          label="Average visit"
          value={group.sessionCount > 0
            ? fmtDuration(group.seconds / group.sessionCount)
            : "—"}
          hint={`Time in range divided by its ${countNoun(group.sessionCount, "visit")}.`}
        />
        <DetailMetric
          label="Days seen"
          value={String(group.daysSeen)}
          hint={`Out of ${countNoun(rangeDays, "day")} in this range.`}
        />
        <DetailMetric label="Last seen" value={formatLastSeen(group.lastSeen)} />
      </div>
      <PanelSection
        title="Classification"
        right={<span className="shrink-0"><Button onClick={() => onMakeRule(group)}>Create Window rule</Button></span>}
      >
        <p className="mt-2 text-[11.5px] text-ink-2">{classification.label}</p>
        {exceptionalProvenance && (
          <p className="mt-1 truncate text-[10.5px] text-ink-3" title={classification.detail}>
            {classification.detail}
          </p>
        )}
      </PanelSection>
      <section className="mt-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-[13px] font-semibold">Visits</h3>
          <Button onClick={() => onToggleAllSessions(group.sessionIds)}>
            {allSelected ? "Clear selection" : `Select all ${group.sessionCount} visits`}
          </Button>
          {selectedSessionIds.size > 0 && (
            <Button variant="danger" onClick={onDeleteSelected}>Delete selected</Button>
          )}
        </div>
        <div className="mt-3 rounded-lg border border-edge/60 bg-surface-2/30 px-3 py-2.5">
          <GroupSessions
            group={group}
            selected={selectedSessionIds}
            onToggle={onToggleSession}
            onEdit={onEditSession}
          />
        </div>
      </section>
    </DetailPanel>
  );
}

/**
 * What decided this entity's classification, in one line.
 *
 * The Window panel has said this since it was built — a label and where it came
 * from — while the identity panel listed a category breakdown and a separate
 * box of rules and left the reader to work out which rule was actually doing
 * the deciding. That is the question the panel is opened to answer.
 *
 * Rule coverage is checked rather than assumed: a rule can decide most of an
 * entity's time while manual corrections carry the rest, and claiming the rule
 * explains all of it would send someone editing the wrong thing.
 */
export function entityClassification(entity: ActivityEntitySummary): {
  label: string;
  detail: string;
} {
  const kind = entity.kind === "website" ? "website" : "app";
  if (entity.status === "uncategorized") {
    return { label: "Uncategorized", detail: `No rule matches this ${kind}.` };
  }
  if (entity.status === "ignored") {
    return { label: "Ignored", detail: "Recorded, but left out of every Insights total." };
  }
  if (entity.status === "partial") {
    return {
      label: "Mixed",
      detail: `${fmtDuration(entity.uncategorizedSeconds)} of this is still uncategorized.`,
    };
  }
  if (entity.status === "mixed") {
    return {
      label: `Mixed · ${entity.categories.length} categories`,
      detail: entity.rules.length > 1
        ? `${entity.rules.length} rules decide it across its visits.`
        : "Its visits resolve to different categories.",
    };
  }
  const label = entity.categories[0]?.name ?? "Uncategorized";
  const ruleSeconds = entity.rules.reduce((total, rule) => total + rule.seconds, 0);
  // A second of slack: clipping a session to the range's edge is rounded the
  // same way on both sides, and a one-second remainder is not a correction.
  const corrected = entity.seconds - ruleSeconds > 1;
  if (entity.rules.length === 0) {
    return { label, detail: "Set by manual corrections — no rule matches." };
  }
  const source = entity.rules.length === 1
    ? describeRuleSource(entity.rules[0], entity.key)
    : `${entity.rules.length} rules, led by ${entity.rules[0].pattern}`;
  return { label, detail: corrected ? `${source}, plus manual corrections` : source };
}

/** A rule's pattern is worth printing only when it says something the panel's
 *  header has not. An App rule on `code.exe`, described inside a panel whose
 *  third line is already `code.exe`, is three words that add nothing — but a
 *  Window rule's pattern is never shown anywhere else. */
function describeRuleSource(rule: ActivityEntityRuleSlice, entityKey: string): string {
  const kind = `${RULE_LABELS[rule.matchType]} rule`;
  return rule.pattern.toLowerCase() === entityKey.toLowerCase() ? kind : `${kind} · ${rule.pattern}`;
}

/**
 * How an entity's time divides, drawn as well as listed.
 *
 * The list alone gave four durations and no sense of their proportions, in a
 * tab where every other list of times draws a bar. Colour here is the category's
 * own — unlike the table's single-accent bar, telling the slices apart *is* the
 * job, and category colour is what this app already means by it.
 */
function CategorySplit({ entity }: { entity: ActivityEntitySummary }) {
  const slices = [
    ...entity.categories.map((category) => ({
      key: `category:${category.categoryId}`,
      name: category.name,
      color: category.color,
      seconds: category.seconds,
    })),
    ...(entity.uncategorizedSeconds > 0
      ? [{
          key: "uncategorized",
          name: "Uncategorized",
          color: UNCATEGORIZED,
          seconds: entity.uncategorizedSeconds,
        }]
      : []),
  ];
  const total = slices.reduce((sum, slice) => sum + slice.seconds, 0);
  // One slice is not a division. Drawing a full-width bar and a row reading
  // "100%" only restates the label directly above it.
  if (total <= 0 || slices.length < 2) return null;
  const share = (seconds: number) => {
    const percent = (seconds / total) * 100;
    return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  };
  return (
    <>
      <span aria-hidden="true" className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        {slices.map((slice) => (
          <span
            key={slice.key}
            style={{ width: `${(slice.seconds / total) * 100}%`, backgroundColor: slice.color }}
          />
        ))}
      </span>
      <div className="mt-3 flex flex-col gap-2">
        {slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-2 text-[11.5px]">
            <CategoryDot color={slice.color} />
            <span className="min-w-0 flex-1 truncate">{slice.name}</span>
            <span className="tabular-nums text-ink-3">{fmtDuration(slice.seconds)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-3">{share(slice.seconds)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * When the entity was used across the range.
 *
 * No other view answers this for one app: Insights draws every app at once, and
 * a total plus a "days seen" count cannot tell a daily habit from one long
 * week. Columns are the range's calendar days — empty ones included, because a
 * gap is most of what there is to see.
 */
function UsageStrip({ buckets }: { buckets: ActivityDayBucket[] }) {
  const peak = buckets.reduce((most, bucket) => Math.max(most, bucket.seconds), 0);
  if (buckets.length < 2 || peak <= 0) return null;
  const spanLabel = (bucket: ActivityDayBucket) => (bucket.days === 1
    ? formatShortDate(bucket.startSec)
    : `${formatShortDate(bucket.startSec)} – ${formatShortDate(bucket.endSec - 1)}`);
  return (
    <section className="mt-6">
      <h3 className="text-[13px] font-semibold">When it was used</h3>
      <div className="mt-2.5 flex h-10 items-end gap-px border-b border-edge/70">
        {buckets.map((bucket) => (
          <span
            key={bucket.startSec}
            title={`${spanLabel(bucket)} · ${fmtDuration(bucket.seconds)}`}
            className="flex h-full flex-1 items-end"
          >
            <span
              className="w-full rounded-t-[2px] bg-accent/75"
              // A day with a minute on it still gets a visible mark: the strip
              // is read for whether something happened at all, not for how
              // much. The floor is in pixels because a percentage of a 40px
              // strip drew a hairline that read as a rule, not a bar.
              style={bucket.seconds > 0
                ? { height: `${(bucket.seconds / peak) * 100}%`, minHeight: 4 }
                : { height: 0 }}
            />
          </span>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-ink-3">
        <span>{formatShortDate(buckets[0].startSec)}</span>
        <span>{fmtDuration(peak)} on the busiest {buckets[0].days === 1 ? "day" : "column"}</span>
        <span>{formatShortDate(buckets[buckets.length - 1].endSec - 1)}</span>
      </div>
    </section>
  );
}

/** The four orders the window list can take, as one control. Each is a whole
 *  answer ("most time"), not a column plus a direction to work out. */
const WINDOW_ORDERS: { value: string; label: string; sort: ActivityWindowSort; direction: ActivitySortDirection }[] = [
  { value: "seconds:desc", label: "Most time", sort: "seconds", direction: "desc" },
  { value: "lastSeen:desc", label: "Most recent", sort: "lastSeen", direction: "desc" },
  { value: "days:desc", label: "Most days", sort: "days", direction: "desc" },
  { value: "title:asc", label: "Title A–Z", sort: "title", direction: "asc" },
];

function EntityPanel({
  dock,
  overlapping,
  entity,
  groups,
  usage,
  rangeSeconds,
  rangeDays,
  hasStoredTitles,
  detailSearch,
  onDetailSearch,
  detailSort,
  detailDirection,
  onDetailSort,
  onLoadMore,
  onClose,
  categories,
  rules,
  aliases,
  onDeleteEntity,
  onExclude,
  onOpenWindow,
  onAssign,
  onSaveAlias,
  onRemoveExactRule,
}: {
  dock: CSSProperties | null;
  overlapping: boolean;
  entity: ActivityEntitySummary;
  groups: ActivityTitleGroupPage;
  usage: ActivityDayBucket[];
  /** All recorded time in the range, for the share this entity holds of it. */
  rangeSeconds: number;
  /** Calendar days the range spans, so "days seen" has a denominator. */
  rangeDays: number;
  hasStoredTitles: boolean;
  detailSearch: string;
  onDetailSearch: (value: string) => void;
  detailSort: ActivityWindowSort;
  detailDirection: ActivitySortDirection;
  onDetailSort: (sort: ActivityWindowSort, direction: ActivitySortDirection) => void;
  onLoadMore: () => void;
  onClose: () => void;
  categories: Category[];
  rules: Rule[];
  aliases: Record<string, string>;
  onDeleteEntity: () => void;
  onExclude: () => void;
  onOpenWindow: (group: ActivityTitleGroup) => void;
  onAssign: (categoryId: number) => Promise<void>;
  onSaveAlias: (alias: string) => Promise<void>;
  onRemoveExactRule: () => Promise<void>;
}) {
  const kindLabel = entity.kind === "website" ? "website" : "app";
  const savedAlias = aliases[entity.key.toLowerCase()] ?? "";
  const [aliasDraft, setAliasDraft] = useState(savedAlias);
  const [renaming, setRenaming] = useState(false);
  const [confirmingRuleRemoval, setConfirmingRuleRemoval] = useState(false);
  const cancelAlias = useRef(false);
  useEffect(() => setAliasDraft(savedAlias), [savedAlias, entity.key]);
  // Both are about the entity in front of the reader, and the arrow keys can
  // change that without anything being clicked.
  useEffect(() => {
    setRenaming(false);
    setConfirmingRuleRemoval(false);
  }, [entity.id]);
  const commitAlias = () => {
    setRenaming(false);
    if (cancelAlias.current) {
      cancelAlias.current = false;
      setAliasDraft(savedAlias);
    } else if (aliasDraft.trim() !== savedAlias) {
      void onSaveAlias(aliasDraft);
    }
  };

  // The standing rule for this exact app or domain, when there is one. It is
  // the panel's one real "current value", so the menu can show it instead of
  // forever offering to set something it may already have set.
  const exactRule = entity.exactRuleId !== null
    ? rules.find((rule) => rule.id === entity.exactRuleId) ?? null
    : null;
  const summary = entityClassification(entity);
  const order = WINDOW_ORDERS.find(
    (option) => option.sort === detailSort && option.direction === detailDirection,
  );
  // Titles are off by default at capture, and can be turned on part way
  // through a history — so an entity can have windows and still have nothing to
  // name them with, whatever the database holds overall.
  const untitled = groups.rows.length > 0 && groups.rows.every((group) => !group.title);
  const titlesReadable = hasStoredTitles && !untitled;
  // Only an entity that resolves to exactly one category has a baseline its
  // windows can be silent about.
  const baselineCategoryId = entity.status === "single"
    ? entity.categories[0]?.categoryId ?? null
    : null;

  return (
    <DetailPanel
      dock={dock}
      overlapping={overlapping}
      label={`Activity details: ${entity.displayName}`}
      eyebrow={
        <>
          <span>{entity.kind}</span>
          {entity.isNew && (
            <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
          )}
          {entity.noise && (
            <RowTag
              title={entity.noise === "utility"
                ? "Looks like an installer, driver, or local file — normally hidden from the list."
                : "Seen briefly and rarely across all history — normally hidden from the list."}
            >
              {entity.noise === "utility" ? "Utility" : "Rare"}
            </RowTag>
          )}
        </>
      }
      heading={renaming ? (
        <input
          autoFocus
          value={aliasDraft}
          placeholder={entity.displayName}
          aria-label={`Rename ${entity.displayName}`}
          onChange={(event) => setAliasDraft(event.target.value)}
          onBlur={commitAlias}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") {
              // Kept from the panel's own Escape, which would otherwise close
              // the thing being renamed rather than cancel the rename.
              event.stopPropagation();
              cancelAlias.current = true;
              event.currentTarget.blur();
            }
          }}
          className="mt-0.5 w-full rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-lg font-semibold outline-none focus:border-accent/60"
        />
      ) : (
        // Edited where it is shown. The rename field used to be its own section
        // a third of the way down the panel, away from the name it renamed and
        // ahead of everything anyone actually opens this for.
        <h2 className="group flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-lg font-semibold">{entity.displayName}</span>
          <button
            type="button"
            onClick={() => { cancelAlias.current = false; setAliasDraft(savedAlias); setRenaming(true); }}
            title="Rename"
            aria-label={`Rename ${entity.displayName}`}
            className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </h2>
      )}
      // Three lines and no more: kind, name, identity. Which browsers a site
      // was seen in used to sit here, and it bought a fourth line and a broken
      // symmetry for a fact that is the same one browser for almost everybody.
      subtitle={
        <>
          {/* No title attribute: it repeated the very text it sat on. The
              table row this panel was opened from still carries the key as its
              own tooltip, where the visible text is the friendly name and the
              two genuinely differ. */}
          <p className="truncate font-mono text-[11px] text-ink-3">{entity.key}</p>
          {renaming && (
            <p className="mt-1 text-[10.5px] text-ink-3">Enter or click away to save. Leave blank to use the recorded name.</p>
          )}
        </>
      }
      onClose={onClose}
      closeLabel="Close activity details"
    >
      {/* Two across, not four. In a panel this narrow a quarter is about 100px,
          which "Today, 4:46 PM" does not fit into — the tile that most wanted
          the friendlier wording was the one being truncated by it. */}
      <div className="grid grid-cols-2 gap-3">
        {/* Each hint carries the fact its tile could not fit — a share, a
            denominator, the arithmetic behind a derived number — and stops
            there. No restating the label, and no sentence explaining how to
            feel about the figure. */}
        <DetailMetric
          label="Time in range"
          value={fmtDuration(entity.seconds)}
          hint={rangeSeconds > 0
            ? `${((entity.seconds / rangeSeconds) * 100).toFixed(entity.seconds / rangeSeconds < 0.1 ? 1 : 0)}% of everything recorded across the ${countNoun(rangeDays, "day")} shown.`
            : `Measured across the ${countNoun(rangeDays, "day")} shown.`}
        />
        {/* A raw visit count had no scale to be read against — 359 tells you
            nothing on its own. Dividing it into the time does: a minute means
            something glanced at constantly, an hour something settled into.
            The count it replaces is in the hint, where it is still checkable. */}
        <DetailMetric
          label="Average visit"
          value={entity.sessionCount > 0
            ? fmtDuration(entity.seconds / entity.sessionCount)
            : "—"}
          hint={`Time in range divided by its ${countNoun(entity.sessionCount, "visit")}.`}
        />
        <DetailMetric
          label="Days seen"
          value={String(entity.daysSeen)}
          hint={`Out of ${countNoun(rangeDays, "day")} in this range.`}
        />
        {/* No hint. The tile is already the whole sentence, and the first-seen
            date it used to carry answers a question nobody asked of it. */}
        <DetailMetric label="Last seen" value={formatLastSeen(entity.lastSeen)} />
      </div>

      <UsageStrip buckets={usage} />

      <PanelSection
        title="Classification"
        right={
          <span className="shrink-0">
            <MenuSelect
              align="end"
              // A standing exact rule is a real current value, so the trigger
              // names it; without one this stays an action menu whose trigger
              // falls back to a prompt, because several categories can be in
              // play at once and none of them is "the" answer.
              value={exactRule ? String(exactRule.categoryId) : ""}
              placeholder={entity.kind === "website" ? "Set website category…" : "Set app default…"}
              label={entity.kind === "website" ? "Set website category" : "Set app default"}
              // No explanatory header. The menu sizes itself to its widest
              // line, so a sentence in here stretched a list of one-word
              // categories to twice the width it needed — and the banner
              // raised on assignment already states the scope, at the one
              // moment it is about to matter.
              onChange={(value) => void onAssign(Number(value))}
              options={categories.map((category) => ({
                value: String(category.id),
                label: category.name,
                dot: category.color,
              }))}
            />
          </span>
        }
      >
        {/* What decided it, not what it is. The trigger beside this heading
            already names the category whenever there is a standing rule to
            name, so repeating it here spent the section's first and most
            emphasised line restating the control next to it. The category
            returns as the lead only when the trigger is showing a prompt
            instead — mixed, uncategorized, or decided by some other rule. */}
        {!exactRule && <p className="mt-2 text-xs text-ink-2">{summary.label}</p>}
        {/* No flex-1 on the text: letting it grow parked the remove button
            against the panel's right edge, half a panel away from the two
            words it acts on. Sized to its content, the button lands beside
            them. */}
        <div className={`flex items-center gap-1.5 ${exactRule ? "mt-2" : "mt-0.5"}`}>
          <p className={`min-w-0 leading-snug ${
            exactRule ? "text-xs text-ink-2" : "text-[11.5px] text-ink-3"
          }`}
          >
            {summary.detail}
          </p>
          {/* The app's own row-level delete, sized to the one line it removes.
              A full bordered button here was wider than the rule it offered to
              undo, and louder than anything else in the section. */}
          {exactRule && !confirmingRuleRemoval && (
            // The glyph sits high in its own em box, so centring the button
            // box still leaves the ✕ a shade above the line it belongs to. One
            // pixel is the whole correction — two overshot it.
            <span className="flex translate-y-px">
              <RemoveButton
                compact
                label={`Remove the ${entity.kind === "website" ? "Website" : "App"} rule for ${entity.key}`}
                onClick={() => setConfirmingRuleRemoval(true)}
              />
            </span>
          )}
        </div>
        {entity.status === "mixed" && (
          <p className="mt-2 text-[11px] text-ink-3">Website and Window rules can override an App default.</p>
        )}
        <CategorySplit entity={entity} />
        {/* Only when there is something to compare. A single rule is already
            named in the line above, and repeating it in a bordered box read as
            two different facts about the same thing. */}
        {entity.rules.length > 1 && (
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
        {exactRule && confirmingRuleRemoval && (
          // Removing a standing rule used to be one click on a red word at the
          // end of a dense section, with nothing to confirm and nothing saying
          // what it would cost.
          <div className="mt-3 rounded-lg border border-bad/25 bg-bad/[.035] px-3 py-2.5 text-[11px] leading-snug text-ink-2">
            <p>
              Remove the {entity.kind === "website" ? "Website" : "App"} rule
              {" "}<span className="font-mono">{exactRule.pattern}</span>? Time it decided becomes
              uncategorized unless another rule matches. Manual corrections are kept.
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button onClick={() => setConfirmingRuleRemoval(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => { setConfirmingRuleRemoval(false); void onRemoveExactRule(); }}
              >
                Remove rule
              </Button>
            </div>
          </div>
        )}
      </PanelSection>

      {/* Windows rather than raw sessions, for the same reason search
          results changed: this entity's list is one app's worth of the
          same fragmentation, and "45 windows" is a thing to read where
          "1269 sessions" is not. */}
      <section className="mt-6">
        {/* Stuck to the top of the panel's scroll, because this is the long
            list: the filter and the order are useless once they have scrolled
            away. The negative margins carry the background across the scroll
            well's padding so rows pass underneath rather than beside. */}
        <div className="sticky top-0 z-10 -mx-5 -mt-2 bg-surface px-5 pb-2.5 pt-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold">Windows</h3>
            {/* Labelled counts, phrased so the heading is not repeated back at
                the reader — "Windows · 2 windows · 309 visits" was three
                sayings of two facts. */}
            <span className="min-w-0 truncate text-[10.5px] tabular-nums text-ink-3">
              {groups.sessionTotal > groups.total
                ? `${countNoun(groups.sessionTotal, "visit")} in ${countNoun(groups.total, "window")}`
                : countNoun(groups.total, "window")}
            </span>
          </div>
          {/* Narrowing and ordering sit together, because they are the same
              kind of act on the same list. The privacy toggle that used to
              take this row is gone: consent to seeing titles is given once, by
              turning capture on, and re-asking it here every session bought a
              control that mostly sat checked. */}
          {titlesReadable && (
            <div className="mt-2.5 flex items-center gap-2">
              <ClearableInput
                value={detailSearch}
                onChange={onDetailSearch}
                label="Filter windows"
                placeholder="Filter windows…"
                className="min-w-0 flex-1"
              />
              {groups.total > 1 && (
                <span className="shrink-0">
                  <MenuSelect
                    size="field"
                    variant="quiet"
                    align="end"
                    label="Order windows by"
                    value={order?.value ?? "seconds:desc"}
                    onChange={(value) => {
                      const picked = WINDOW_ORDERS.find((option) => option.value === value);
                      if (picked) onDetailSort(picked.sort, picked.direction);
                    }}
                    options={WINDOW_ORDERS.map(({ value, label }) => ({ value, label }))}
                  />
                </span>
              )}
            </div>
          )}
        </div>
        {!titlesReadable ? (
          // A list of identical "—" rows, one per entity, is what this used to
          // render when nothing had a title to group by.
          <p className="rounded-lg border border-edge/60 bg-surface-2/30 px-3 py-4 text-[11px] leading-snug text-ink-3">
            No window titles were recorded for this {kindLabel}, so its{" "}
            {countNoun(groups.sessionTotal, "visit")} cannot be broken down. Title capture is off by
            default; Settings can turn it on for what is recorded from now on.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {groups.rows.map((group) => (
                <PanelWindowRow
                  key={group.key}
                  group={group}
                  search={detailSearch}
                  maxSeconds={groups.maxSeconds}
                  totalSeconds={entity.seconds}
                  category={windowRowCategory(group, baselineCategoryId)}
                  onOpen={onOpenWindow}
                />
              ))}
              {groups.rows.length === 0 && (
                <p className="py-5 text-center text-[11px] text-ink-3">No windows match this filter.</p>
              )}
            </div>
            {groups.rows.length < groups.total && (
              <LoadMore shown={groups.rows.length} total={groups.total} onClick={onLoadMore} />
            )}
          </>
        )}
      </section>

      {/* Curation last, and one clean row. Each action used to carry its own
          paragraph, which is four lines of standing prose to explain two
          buttons that both open a dialog stating the same thing in full. The
          sentences moved onto the buttons, where they are read by whoever is
          hesitating and by nobody else. */}
      <section className="mt-7 border-t border-edge/60 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-[13px] font-semibold text-ink-2">Manage this {kindLabel}</h3>
          <Button
            onClick={onExclude}
            title={`Never record this ${kindLabel} again. Existing history is kept.`}
          >
            Do not track
          </Button>
          <Button
            variant="quiet-danger"
            onClick={onDeleteEntity}
            title="Removes recorded visits. Categories, rules, and aliases are kept."
          >
            Delete activity
          </Button>
        </div>
      </section>
    </DetailPanel>
  );
}

function DetailMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** Explains the measure on hover or focus, the way the Insights tiles do.
   *  Anything that would otherwise become a second line under the value
   *  belongs here — four tiles in a grid only read as a set while they are
   *  the same height. */
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-edge bg-surface-2 p-3">
      <p className="text-[10px] text-ink-3">
        {hint ? (
          // The label joins the *accessible* name only. A screen reader has no
          // layout telling it the tooltip belongs to the label above it, so it
          // needs both; the visible tooltip already sits under that label and
          // printing it again there was restating the tile to its own reader.
          <FloatingTooltip
            text={hint}
            ariaLabel={`${label}. ${hint}`}
            className="cursor-help outline-none"
          >
            {label}
          </FloatingTooltip>
        ) : label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums" title={value}>{value}</p>
    </div>
  );
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
      {/* An icon, because the word sat in the card's header competing with the
          view switcher for a control almost nobody presses. The tooltip keeps
          the noun — "export" alone never said what came out. */}
      {/* No border and the dimmest ink, matching the filtered-rows button it
          sits beside. A bordered box drew a rectangle in the corner of the
          card that outweighed everything in the header except the switcher —
          loud framing for the control here that is pressed least. It takes its
          definition on hover, like every other quiet control in the app. */}
      <summary
        title="Download CSV"
        aria-label="Download CSV"
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/[.05] hover:text-ink-2"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      </summary>
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
 * Scope defaults to the exact website when one is known, otherwise the exact
 * process. "Skill Tree" in an editor is a project; in a browser it might be
 * anything. A broader reading must be a deliberate choice.
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
  const [spec, setSpec] = useState<TitleRuleSpec>(() => defaultWindowRuleSpec(group));
  const [candidates, setCandidates] = useState<TitleRuleCandidate[] | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<TitleRulePreview | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCandidates(null);
    setSelectedCandidateId("");
    if (!source) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = suggestTitleRuleCandidates(
        source,
        group.title,
        { scopeKind: spec.scopeKind, scopeValue: spec.scopeValue },
        [group.displayName, group.entityKey],
      );
      if (cancelled) return;
      setCandidates(next);
      if (next[0]) {
        setSpec(ruleSpecFromCandidate(next[0]));
        setSelectedCandidateId(next[0].id);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, group.key, spec.scopeKind, spec.scopeValue]);

  // Count against all history, like the rule list's "unused" tag. Deferring
  // keeps typing in Advanced responsive even when the history is large.
  const deferredSpec = useDeferredValue(spec);
  useEffect(() => {
    setPreview(null);
    if (!source || !deferredSpec.pattern.trim() || !titleSpecReady(deferredSpec)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = previewTitleRule(source, deferredSpec);
      if (!cancelled) setPreview(next);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, deferredSpec]);

  const chooseCandidate = (candidate: TitleRuleCandidate) => {
    setSpec(ruleSpecFromCandidate(candidate));
    setSelectedCandidateId(candidate.id);
  };
  const changeSpec = (patch: Partial<TitleRuleSpec>) => {
    setSelectedCandidateId("");
    setSpec((current) => {
      const next = { ...current, ...patch };
      return next.titleMatchMode === "segment"
        ? next
        : { ...next, titleAnchor: "any" };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await addRule("title", spec.pattern, Number(categoryId), spec);
      banner.show(`Window rule “${spec.pattern.trim()}” added.`);
      onSaved();
    } catch (error) {
      banner.report(error, "rule");
      setSaving(false);
    }
  };
  const saveBroadRule = async () => {
    setSaving(true);
    try {
      const matchType = group.entityKind === "website" ? "domain" : "process";
      await addRule(matchType, group.entityKey, Number(categoryId));
      banner.show(`${RULE_LABELS[matchType]} rule for ${group.displayName} added.`);
      onSaved();
    } catch (error) {
      banner.report(error, "rule");
      setSaving(false);
    }
  };
  const scopeOptions = titleRuleScopeOptions(group, browserProcesses);
  const encodedScope = encodeTitleScope(spec.scopeKind, spec.scopeValue);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="window-rule-title">
      <div className="scroll-well max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-edge bg-surface p-5 shadow-2xl">
        <h2 id="window-rule-title" className="text-base font-semibold">New Window rule</h2>
        <p className="mt-1 text-[11px] text-ink-3">
          Choose what this window has in common with the other windows you mean.
          The rule applies to past and future activity.
        </p>

        <div className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px]">
          <p className="truncate font-medium" title={group.title}>{group.title}</p>
          <p className="mt-1 text-ink-3">
            {group.displayName} · {group.sessionCount} visit{group.sessionCount === 1 ? "" : "s"} · {fmtDuration(group.seconds)} in range
          </p>
        </div>

        <div className="mt-4">
          <p className="text-[11px] text-ink-3">Suggested matches</p>
          {candidates === null ? (
            <div className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-3">
              <Spinner label="Comparing with your title history…" />
            </div>
          ) : candidates.length > 0 ? (
            <div className="mt-2 grid gap-2">
              {candidates.map((candidate) => {
                const selected = selectedCandidateId === candidate.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-accent/60 bg-accent/[.08]"
                        : "border-edge bg-surface-2 hover:border-edge-2"
                    }`}
                    onClick={() => chooseCandidate(candidate)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {candidate.pattern}
                      </span>
                      {candidate.recommended && (
                        <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] text-ink-2">
                          recommended
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[10.5px] text-ink-3">
                      {describeTitleRule(candidate)} · {Math.round(candidate.reach * 100)}% of
                      titled windows in this scope · {candidate.days} active{" "}
                      {candidate.days === 1 ? "day" : "days"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-3">
              This title has no durable, reusable part in the selected scope. Use
              an App or Website rule if all of {group.displayName} belongs together,
              or open Advanced to write a precise rule yourself.
            </p>
          )}
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

        <button
          type="button"
          className="mt-3 text-[11px] text-ink-3 hover:text-ink-2"
          onClick={() => setAdvanced((current) => !current)}
          aria-expanded={advanced}
        >
          {advanced ? "Hide advanced options" : "Advanced matching and scope"}
        </button>
        {advanced && (
          <div className="mt-2 rounded-lg border border-edge bg-surface-2 p-3">
            <label className="block text-[10.5px] text-ink-3">
              Text to match
              <input
                value={spec.pattern}
                onChange={(event) => changeSpec({ pattern: event.target.value })}
                className="mt-1 block w-full rounded-lg border border-edge bg-surface px-2.5 py-2 text-xs text-ink outline-none focus:border-accent/60"
              />
            </label>
            <div className="mt-3">
              <span className="text-[10.5px] text-ink-3">Match as</span>
              <span className="mt-1 flex w-fit rounded-lg border border-edge bg-surface p-0.5">
                {([
                  ["phrase", "Whole words"],
                  ["segment", "Exact title part"],
                  ["contains", "Contains text"],
                ] as Array<[TitleRuleMatchMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-md px-2 py-1 text-[10.5px] ${
                      spec.titleMatchMode === mode
                        ? "bg-surface-3 text-ink-2"
                        : "text-ink-3 hover:text-ink-2"
                    }`}
                    onClick={() => changeSpec({ titleMatchMode: mode })}
                  >
                    {label}
                  </button>
                ))}
              </span>
              {spec.titleMatchMode === "contains" && (
                <p className="mt-1.5 text-[10px] leading-snug text-ink-3">
                  Broadest option: it can also match inside longer words. Prefer a
                  suggested whole-word or exact-part rule when one is available.
                </p>
              )}
            </div>
            {spec.titleMatchMode === "segment" && (
              <div className="mt-3 text-[10.5px] text-ink-3">
                <span>Position</span>
                <MenuSelect
                  size="field"
                  className="mt-1 w-full"
                  value={spec.titleAnchor}
                  onChange={(value) => changeSpec({ titleAnchor: value as TitleRuleAnchor })}
                  label="Title-part position"
                  options={[
                    { value: "any", label: "Anywhere in the title" },
                    { value: "first", label: "First title part" },
                    { value: "interior", label: "Middle title part" },
                    { value: "last", label: "Last title part" },
                  ]}
                />
              </div>
            )}
            <div className="mt-3 text-[10.5px] text-ink-3">
              <span>Where it applies</span>
              <MenuSelect
                size="field"
                className="mt-1 w-full"
                value={encodedScope}
                onChange={(value) => {
                  const scope = decodeTitleScope(value);
                  changeSpec(scope);
                }}
                label="Rule scope"
                options={scopeOptions}
              />
            </div>
          </div>
        )}

        {/* The safety net for a pattern aimed too widely: say what it takes
            before it takes it, counted over all history rather than the range
            on screen, because that is the scope a rule actually has. */}
        <p className="mt-3 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-3">
          {!spec.pattern.trim()
            ? "Enter text this rule should match."
            : preview === null
              ? "Counting what this would match…"
              : preview.sessions === 0
                ? "Nothing in your history matches this yet. It will still apply to future activity."
                : (
                  <>
                    Claims <span className="text-ink-2">{preview.sessions}</span> session
                    {preview.sessions === 1 ? "" : "s"} with{" "}
                    <span className="text-ink-2">{preview.titles}</span> distinct title
                    {preview.titles === 1 ? "" : "s"} across{" "}
                    <span className="text-ink-2">{preview.days}</span> active{" "}
                    {preview.days === 1 ? "day" : "days"} —{" "}
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
          <Button
            disabled={saving || !categoryId}
            title={`Use one ${group.entityKind === "website" ? "Website" : "App"} rule instead of inspecting the title`}
            onClick={() => void saveBroadRule()}
          >
            Classify all of {group.displayName}
          </Button>
          <span className="flex-1" />
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || !spec.pattern.trim() || !categoryId || !titleSpecReady(spec)}
            onClick={() => void save()}
          >
            {saving ? "Adding…" : "Add rule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function titleSpecReady(
  spec: Pick<TitleRuleSpec, "scopeKind" | "scopeValue">,
): boolean {
  if (spec.scopeKind === "any" || spec.scopeKind === "browsers") return true;
  return spec.scopeValue.trim() !== "";
}

function ruleDraftReady(
  draft: { type: MatchType } & Pick<TitleRuleSpec, "scopeKind" | "scopeValue">,
): boolean {
  if (draft.type !== "title") return true;
  return titleSpecReady(draft);
}

/**
 * A history-free fallback while ranked candidates are being computed. It never
 * returns the whole delimiter-bearing title or a version-bearing part.
 */
export function defaultRulePattern(title: string): string {
  const durable = splitWindowTitle(title)
    .filter((part) => part.length >= 3 && !containsVersion(part));
  return durable.reduce(
    (best, part) => part.length >= best.length ? part : best,
    "",
  ) || normalizeWindowTitle(title);
}

function defaultWindowRuleSpec(group: ActivityTitleGroup): TitleRuleSpec {
  return {
    pattern: defaultRulePattern(group.title),
    scopeKind: group.entityKind === "website" ? "domain" : "process",
    scopeValue: group.entityKey.toLowerCase(),
    titleMatchMode: "segment",
    titleAnchor: "any",
  };
}

function encodeTitleScope(kind: TitleRuleScopeKind, value: string): string {
  return `${kind}:${value}`;
}

function decodeTitleScope(value: string): Pick<TitleRuleSpec, "scopeKind" | "scopeValue"> {
  const colon = value.indexOf(":");
  const scopeKind = value.slice(0, colon) as TitleRuleScopeKind;
  return { scopeKind, scopeValue: value.slice(colon + 1) };
}

function titleRuleScopeOptions(
  group: ActivityTitleGroup,
  browserProcesses: string[],
): MenuOption[] {
  const process = group.sessions[0]?.process.toLowerCase();
  const options: MenuOption[] = [];
  if (group.entityKind === "website") {
    options.push({
      value: encodeTitleScope("domain", group.entityKey),
      label: `Only ${group.entityKey}`,
    });
  } else {
    options.push({
      value: encodeTitleScope("process", group.entityKey),
      label: `Only ${group.displayName} (${group.entityKey})`,
    });
  }
  if (
    process &&
    group.entityKind === "website"
  ) {
    options.push({
      value: encodeTitleScope("process", process),
      label: `Only this browser (${process})`,
    });
  }
  if (group.entityKind === "website" || (process && browserProcesses.includes(process))) {
    options.push({ value: encodeTitleScope(BROWSER_SCOPE, ""), label: "Any browser" });
  }
  options.push({ value: encodeTitleScope(ANY_APP, ""), label: "Any app" });
  return options;
}

function ruleSpecFromCandidate(candidate: TitleRuleCandidate): TitleRuleSpec {
  return {
    pattern: candidate.pattern,
    scopeKind: candidate.scopeKind,
    scopeValue: candidate.scopeValue,
    titleMatchMode: candidate.titleMatchMode,
    titleAnchor: candidate.titleAnchor,
  };
}

function describeTitleRule(
  spec: Pick<TitleRuleSpec, "titleMatchMode" | "titleAnchor">,
): string {
  if (spec.titleMatchMode === "phrase") return "whole words";
  if (spec.titleMatchMode === "contains") return "contains text";
  if (spec.titleAnchor === "any") return "exact title part";
  if (spec.titleAnchor === "interior") return "exact middle part";
  return `exact ${spec.titleAnchor} part`;
}

function titleRuleScopeLabel(
  rule: Pick<Rule, "scopeKind" | "scopeValue">,
): string {
  if (rule.scopeKind === "domain") return rule.scopeValue ?? "one website";
  if (rule.scopeKind === "process") return rule.scopeValue ?? "one app";
  if (rule.scopeKind === "browsers") return "browsers";
  return "any app";
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
  scope: DeleteScope;
  onClose: () => void;
  onDeleted: (request: ActivityDeleteRequest) => void;
}) {
  const banner = useBanner();
  const [preview, setPreview] = useState<ActivityDeletePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  // Always opens on the narrower of the two. Widening is a decision someone
  // has to make on purpose, and it is one keystroke away either way.
  const [wide, setWide] = useState(false);
  const widened = wide && scope.allHistory ? scope.allHistory : null;
  const active = widened ?? scope;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void previewActivityDelete(active.request).then(
      (value) => { if (!cancelled) { setPreview(value); setLoading(false); } },
      (error) => { if (!cancelled) { setLoading(false); banner.report(error, "deletion preview"); onClose(); } },
    );
    return () => { cancelled = true; };
  }, [active]);
  const confirm = async () => {
    if (!preview || preview.count === 0) return;
    setDeleting(true);
    try {
      const request = {
        ...active.request,
        snapshotMaxId: preview.snapshotMaxId,
        previewProtectedSessionId: preview.protectedSessionId,
      } as ActivityDeleteRequest & { snapshotMaxId: number };
      const result = await deleteActivity(request);
      if (result.protectedCount > 0) {
        banner.show(`${result.protectedCount} current live session was kept. Pause recording and retry after it closes if you need to remove it.`);
      }
      onDeleted(active.request);
    } catch (error) {
      banner.report(error, "activity deletion");
      setDeleting(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-5">
      <div role="dialog" aria-modal="true" aria-labelledby="delete-activity-title" className="w-full max-w-md rounded-[14px] border border-edge-2 bg-surface p-5 shadow-2xl">
        <h2 id="delete-activity-title" className="text-sm font-semibold">Delete recorded activity?</h2>
        {/* The scope sits above the preview because the preview answers for
            it: every number below this row is the consequence of the choice
            made in it, and both choices are one Delete button away. */}
        {scope.allHistory && (
          <div className="mt-3 flex rounded-lg border border-edge bg-surface-2 p-0.5">
            {[
              { wide: false, label: "Selected range" },
              { wide: true, label: "All history" },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                disabled={deleting}
                aria-pressed={wide === option.wide}
                onClick={() => setWide(option.wide)}
                className={`flex-1 rounded-md px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                  wide === option.wide ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        {loading || !preview ? <div className="py-8"><Spinner label="Checking deletion scope…" /></div> : (
          <>
            {/* Subject on one line, dates on the next. As one sentence it ran
                to three lines of prose that had to be read rather than
                scanned, in the one dialog most worth scanning. */}
            <p className="mt-3 text-xs text-ink-2">{scope.label}</p>
            {active.span && (
              <p className="mt-1 text-[11px] tabular-nums text-ink-3">{active.span}</p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <DetailMetric label="Visits" value={String(preview.count)} />
              <DetailMetric label="Recorded time" value={fmtDuration(preview.seconds)} />
            </div>
            {/* The true extent of the matching sessions used to be printed
                here. It is a near-copy of the scope line above whenever the
                thing was used on the range's first and last day, which is the
                ordinary case, and the tiles beside it already say how little
                is there when it is not. Two date lines in one confirmation
                cost more than the subtlety separating them was worth. */}
            <p className="mt-3 text-[11px] leading-snug text-ink-3">Complete session rows are removed, securely compacted, and cannot be restored unless you have a backup.</p>
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
  type RuleDraft = {
    type: MatchType;
    pattern: string;
    scopeKind: TitleRuleScopeKind;
    scopeValue: string;
    titleMatchMode: TitleRuleMatchMode;
    titleAnchor: TitleRuleAnchor;
  };
  const [drafts, setDrafts] = useState<Record<number, RuleDraft>>({});
  const applied = appliedRuleIds === null ? null : new Set(appliedRuleIds);

  const draftFor = (id: number): RuleDraft =>
    drafts[id] ?? {
      type: "domain" as const,
      pattern: "",
      scopeKind: "process",
      scopeValue: "",
      titleMatchMode: "phrase",
      titleAnchor: "any",
    };
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
      await addRule(
        draft.type,
        draft.pattern,
        categoryId,
        draft.type === "title" ? draft : {},
      );
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
  const resetCount = Number(meta.settings.window_rules_reset_v4_count ?? "0");
  const showResetNotice =
    meta.settings.window_rules_reset_v4_pending === "1" && resetCount > 0;
  const dismissResetNotice = async () => {
    try {
      await updateSetting("window_rules_reset_v4_pending", "0");
      await onChanged();
    } catch (error) {
      banner.report(error, "Window rule notice");
    }
  };

  return (
    // Scrolls itself rather than the page once enough categories are open. The
    // -mr-2/pr-2 pair keeps the scrollbar off the rows without indenting them
    // when there is nothing to scroll.
    <div className="scroll-well -mr-2 flex min-h-0 flex-col overflow-y-auto pr-2">
      {colorMenu !== null && <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 cursor-default" onClick={() => setColorMenu(null)} />}
      {showResetNotice && (
        <div className="mb-3 flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/[.055] px-3 py-2.5 text-[11px] leading-relaxed text-ink-2">
          <p className="min-w-0 flex-1">
            Window matching was upgraded. {resetCount} older Window{" "}
            {resetCount === 1 ? "rule was" : "rules were"} removed because the old
            substring meaning could not be translated reliably. App and Website rules
            were preserved.
          </p>
          <button
            type="button"
            className="shrink-0 text-ink-3 hover:text-ink-2"
            onClick={() => void dismissResetNotice()}
          >
            Dismiss
          </button>
        </div>
      )}
      <p className="mb-4 text-[11px] leading-relaxed text-ink-3">
        Rules classify matching historical and future activity. A Website rule beats a
        general Window rule; a Window rule limited to one website can refine it. Window
        rules beat App rules.
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
                        {rule.matchType === "title" && (
                          <>
                            <span
                              className="shrink-0 rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] text-ink-3"
                              title="How the text is compared with a normalized window title."
                            >
                              {describeTitleRule({
                                titleMatchMode: rule.titleMatchMode ?? "phrase",
                                titleAnchor: rule.titleAnchor ?? "any",
                              })}
                            </span>
                            <span
                              className="max-w-[118px] shrink-0 truncate rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] text-ink-3"
                              title={`Only matches ${titleRuleScopeLabel(rule)}.`}
                            >
                              {titleRuleScopeLabel(rule)}
                            </span>
                          </>
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
                    {draft.type === "title" && (
                      <div className="mt-2 rounded-lg border border-edge/60 bg-surface/45 p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="w-[64px] shrink-0 text-[10.5px] text-ink-3">Match as</span>
                          <span className="flex rounded-lg border border-edge bg-surface p-0.5">
                            {([
                              ["phrase", "Whole words"],
                              ["segment", "Exact part"],
                              ["contains", "Contains"],
                            ] as Array<[TitleRuleMatchMode, string]>).map(([mode, label]) => (
                              <button
                                key={mode}
                                type="button"
                                className={`rounded-md px-2 py-1 text-[10.5px] ${
                                  draft.titleMatchMode === mode
                                    ? "bg-surface-3 text-ink-2"
                                    : "text-ink-3 hover:text-ink-2"
                                }`}
                                onClick={() => setDraft(category.id, {
                                  titleMatchMode: mode,
                                  titleAnchor: mode === "segment" ? draft.titleAnchor : "any",
                                })}
                              >
                                {label}
                              </button>
                            ))}
                          </span>
                        </div>
                        {draft.titleMatchMode === "segment" && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="w-[64px] shrink-0 text-[10.5px] text-ink-3">Position</span>
                            <MenuSelect
                              size="compact"
                              className="w-44"
                              value={draft.titleAnchor}
                              onChange={(value) => setDraft(category.id, {
                                titleAnchor: value as TitleRuleAnchor,
                              })}
                              label="Title-part position"
                              options={[
                                { value: "any", label: "Anywhere" },
                                { value: "first", label: "First part" },
                                { value: "interior", label: "Middle part" },
                                { value: "last", label: "Last part" },
                              ]}
                            />
                          </div>
                        )}
                        <div className="mt-2 flex items-center gap-2">
                          <span className="w-[64px] shrink-0 text-[10.5px] text-ink-3">Applies to</span>
                          <span className="flex rounded-lg border border-edge bg-surface p-0.5">
                            {([
                              [ANY_APP, "Any app"],
                              [BROWSER_SCOPE, "Browsers"],
                              ["process", "One app"],
                              ["domain", "Website"],
                            ] as Array<[TitleRuleScopeKind, string]>).map(([kind, label]) => (
                            <button
                              key={kind}
                              type="button"
                              className={`rounded-md px-2 py-1 text-[10.5px] ${
                                draft.scopeKind === kind
                                  ? "bg-surface-3 text-ink-2"
                                  : "text-ink-3 hover:text-ink-2"
                              }`}
                              onClick={() => setDraft(category.id, {
                                scopeKind: kind,
                                scopeValue:
                                  kind === "any" || kind === "browsers"
                                    ? ""
                                    : draft.scopeValue,
                              })}
                            >
                              {label}
                            </button>
                          ))}
                          </span>
                          {(draft.scopeKind === "process" || draft.scopeKind === "domain") && (
                            <input
                              value={draft.scopeValue}
                              onChange={(event) => setDraft(category.id, {
                                scopeValue: event.target.value,
                              })}
                              placeholder={
                                draft.scopeKind === "process"
                                  ? "obsidian.exe"
                                  : "github.com"
                              }
                              className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none placeholder:text-ink-3 focus:border-accent/60"
                            />
                          )}
                        </div>
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
                      Delete category
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
