import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  Button,
  Card,
  Spinner,
} from "../components/ui";
import { ExtensionLinks } from "../components/ExtensionLinks";
import { withAlias } from "../lib/aliases";
import {
  GROUP_SESSION_SAMPLE,
  currentActivitySessionIds,
  resolveSelectedWindow,
  restrictActivitySessionIds,
  type ActivityEntitySummary,
  type ActivityQuery,
  type ActivityTitleGroup,
  type ActivitySort,
  type ActivitySortDirection,
  type ActivitySource,
  type ActivityTriageItem,
  type ActivityTypeFilter,
  type ActivityWindowSort,
} from "../lib/activity";
import { parseDismissed, serializeDismissed } from "../lib/domainConsolidation";
import { suggestForTriage, suggestionKey } from "../lib/starterSuggestions";
import {
  browserDomainCoverage,
  shouldShowDomainCoverageHint,
  shouldShowWebsiteRuleHint,
  websiteSignalConfirmed,
} from "../lib/domainCoverage";
import {
  countNoun,
  entityRowDomId,
  entityRowTriggerDomId,
  formatDateSpan,
  updateSortState,
} from "../lib/activityFormat";
import { toggleSetValue, toggleSetValues } from "../lib/setUpdates";
import { clipSessions } from "../lib/metrics";
import {
  activityDetailMode,
  detailPanelBox,
  WIDE_DETAIL_MIN,
  useViewportWidth,
} from "../lib/responsive";
import {
  classifySessions,
  restoreSessionClassifications,
  saveProcessAliases,
  updateSetting,
  type ActivityDeleteRequest,
  type SessionClassification,
  type TrackingExclusionKind,
} from "../lib/queries";
import { allTimeRange, calendarDays, type Range } from "../lib/time";
import { useBanner } from "../state/banner";
import { useActivityModel } from "../state/useActivityModel";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";
import { useEntityRuleWrites } from "../state/useEntityRuleWrites";
import ExcludedPanel from "./activity/ExcludedPanel";
import ActivityExportMenu from "./activity/ActivityExportMenu";
import CategoriesAndRules from "./activity/CategoriesAndRules";
import { EntityPanel, WindowPanel } from "./activity/ActivityDetails";
import {
  EntityCatalog,
  LibraryControls,
  SearchResults,
  TableRegion,
  UnclassifiedSection,
  ViewSwitcher,
  type ActivityView,
  type LibraryFilter,
} from "./activity/ActivityTables";
import {
  DeleteActivityDialog,
  SessionCorrectionDialog,
  StarterSuggestionDialog,
  TrackingExclusionDialog,
  WindowRuleDialog,
  type DeleteScope,
} from "./activity/dialogs";

export type { ActivityView } from "./activity/ActivityTables";

const ENTITY_PAGE = 50;
const WINDOW_PAGE = 50;

/** The panel's own window list is a preview, not an archive — the searched
 *  Windows table is where a long list belongs. Fifty rows put half a screen of
 *  scrolling between the reader and the actions below them, for a list whose
 *  first few entries answer "what did I do in here". */
const PANEL_WINDOW_PAGE = 10;
const PANEL_WINDOW_MORE = 20;

/** Visits shown for the one window under inspection, and how many more each
 *  press adds. The first page matches the sample every group already carries,
 *  so opening a window costs no extra work. */
const WINDOW_VISIT_MORE = 50;

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
/** Lets the tab scroll a row into view after the keyboard moved the selection.
 *  Entity ids carry `:` and `.`, which getElementById takes literally. */
/**
 * Where the detail panel goes.
 *
 * The page is a fixed-width column centred in the window, which leaves an equal
 * empty margin down each side. The panel takes the right one. Nothing else on
 * the page moves for it — the table keeps the width it has on every other tab,
 * and the date picker above stays where Insights puts it, which is the whole
 * reason the container is not simply widened.
 *
 * Below WIDE_DETAIL_MIN the panel does not dock at all: it becomes the card's
 * drill-in face. At and above it, this calculation consumes only the real
 * right margin, so the inspector can never cover a table column.
 */
export default function ActivityTab({
  view,
  onViewChange,
  range,
  firstSessionSec,
  historyRevision,
  liveTick,
  isAllTime,
  onTryAllTime,
  openExclusions = false,
  onExclusionsOpened,
}: {
  view: ActivityView;
  onViewChange: (view: ActivityView) => void;
  range: Range;
  firstSessionSec: number | null;
  historyRevision: number;
  /** Advances when the app returns to the foreground, so a tab left open picks
   *  up sessions recorded while the reader was elsewhere. Unlike historyRevision
   *  this keeps the cached rows and refetches only the live edge. */
  liveTick: number;
  isAllTime: boolean;
  onTryAllTime: () => void;
  /** Settings asked for the exclusion list; honored once, on mount. */
  openExclusions?: boolean;
  onExclusionsOpened?: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const viewportWidth = useViewportWidth();
  const detailMode = activityDetailMode(viewportWidth);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [typeFilter, setTypeFilter] = useState<ActivityTypeFilter>("all");
  const [classificationFilter, setClassificationFilter] = useState<LibraryFilter>(
    openExclusions ? "excluded" : "all",
  );
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
  const [windowVisitLimit, setWindowVisitLimit] = useState(GROUP_SESSION_SAMPLE);
  const [detailSort, setDetailSort] = useState<ActivityWindowSort>("seconds");
  const [detailDirection, setDetailDirection] = useState<ActivitySortDirection>("desc");
  const [selectedWindow, setSelectedWindow] = useState<ActivityTitleGroup | null>(null);
  // Back describes the path into a Window, not its parent relationship. A
  // direct Library result has no previous detail panel to return to.
  const [windowOrigin, setWindowOrigin] = useState<"library" | "entity-detail" | null>(null);
  // Visit selection belongs to a detail surface. The compact search table only
  // discovers a Window; it never silently turns one row into hundreds of
  // selected sessions.
  const [panelSessionIds, setPanelSessionIds] = useState<Set<number>>(() => new Set());
  // The entity panel's own selection, one level up: whole Windows rather than
  // individual visits. Kept apart from the visit selection above so that
  // opening a Window and coming back does not discard the batch being built —
  // and so the two can never half-overlap on the same session.
  const [selectedWindowKeys, setSelectedWindowKeys] = useState<Set<string>>(() => new Set());
  const [deleteScope, setDeleteScope] = useState<DeleteScope | null>(null);
  const [excludeScope, setExcludeScope] = useState<{
    kind: TrackingExclusionKind;
    pattern: string;
    label: string;
  } | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [ruleDraft, setRuleDraft] = useState<ActivityTitleGroup | null>(null);

  // The request was consumed by the initial filter above. Retiring it here —
  // rather than where it was raised — keeps a later visit to this tab from
  // silently reopening a filter the reader did not ask for again.
  useEffect(() => {
    if (openExclusions) onExclusionsOpened?.();
  }, []);

  const allRange = useMemo(
    () => allTimeRange(firstSessionSec),
    [firstSessionSec, historyRevision, liveTick],
  );
  const sessionData = useSessions(
    allRange.start.getTime() / 1000,
    allRange.end.getTime() / 1000,
    historyRevision,
    liveTick,
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
    selectedWindowKey: selectedWindow?.key ?? null,
    selectedWindowSessionLimit: windowVisitLimit,
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
    selectedWindow?.key,
    windowVisitLimit,
  ]);
  const analyzed = useActivityModel(source, query);
  const result = analyzed.result;
  const currentResult = analyzed.current ? result : null;
  const currentWindow = useMemo(() => {
    return resolveSelectedWindow(selectedWindow, result, analyzed.current);
  }, [analyzed.current, result, selectedWindow]);

  useEffect(() => {
    if (!selectedWindow || !analyzed.current) return;
    const fresh = result?.selectedWindow ?? null;
    if (!fresh) {
      // The selected window no longer belongs to the current query. Close the
      // inspector instead of leaving controls aimed at an old range/filter.
      setPanelSessionIds(new Set());
      setWindowOrigin(null);
      setSelectedWindow(null);
      setSelectedEntityId(null);
      return;
    }
    setSelectedWindow(fresh);
    setPanelSessionIds((current) => {
      const allowed = new Set(fresh.sessionIds);
      const next = new Set([...current].filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [analyzed.current, result, selectedWindow?.key]);

  // Mutation payloads are filtered against the current worker result as a
  // second line of defence. A stale panel is disabled, but this also protects
  // an event already queued just as a query replacement began.
  const currentSessionIds = useMemo(
    () => currentActivitySessionIds(currentResult),
    [currentResult],
  );

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
    setSelectedWindowKeys(new Set());
  }, [selectedEntityId]);

  useEffect(() => {
    setPanelSessionIds(new Set());
    setWindowVisitLimit(GROUP_SESSION_SAMPLE);
  }, [selectedWindow?.key]);

  // The window selection goes with the filter, not with the order: filtering
  // changes which rows exist, so a selection that survived it would act on
  // windows the reader can no longer see. Re-ordering moves the same rows.
  useEffect(() => {
    setDetailLimit(PANEL_WINDOW_PAGE);
    setPanelSessionIds(new Set());
  }, [detailSearch, detailSort, detailDirection]);

  useEffect(() => {
    setSelectedWindowKeys(new Set());
  }, [detailSearch]);

  const dialogOpen = deleteScope !== null
    || excludeScope !== null
    || ruleDraft !== null
    || editingSessionId !== null;
  const catalogRows = result?.catalog.rows;
  const closeActivityDetail = () => {
    const entityId = selectedEntityId;
    setPanelSessionIds(new Set());
    setWindowOrigin(null);
    setSelectedWindow(null);
    setSelectedEntityId(null);
    if (entityId) {
      requestAnimationFrame(() => {
        document.getElementById(entityRowTriggerDomId(entityId))?.focus();
        document.getElementById(entityRowDomId(entityId))?.scrollIntoView({ block: "nearest" });
      });
    }
  };

  /**
   * The detail panel is an inspector, not a dialog, so the list behind it stays
   * live — and the arrows that would have scrolled that list are worth more
   * spent walking it, which is what triaging a library actually is. Anything
   * with its own arrow behaviour (a field, an open menu) keeps it.
   *
   * Escape follows the same path as the visible chrome: a Window opened from
   * an entity returns there, while a direct Library result closes. A dialog on
   * top owns Escape outright, or closing it would take the panel underneath
   * with it.
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
        if (selectedWindow && windowOrigin === "entity-detail") {
          setWindowOrigin(null);
          setSelectedWindow(null);
        } else {
          closeActivityDetail();
        }
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
  }, [selectedEntityId, selectedWindow, windowOrigin, dialogOpen, catalogRows]);

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
  const [dock, setDock] = useState<CSSProperties | null>(null);
  const panelOpen = view === "library"
    && (currentWindow !== null || (result?.selectedEntity ?? null) !== null);
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node || !panelOpen || detailMode !== "outboard") {
      setDock(null);
      return;
    }
    const measure = () => {
      if (window.innerWidth < WIDE_DETAIL_MIN) {
        setDock(null);
        return;
      }
      const card = node.getBoundingClientRect();
      const box = detailPanelBox(window.innerWidth, card.right);
      const top = Math.max(card.top, 40);
      const bottom = Math.min(card.bottom, window.innerHeight - 16);
      setDock({
        position: "fixed",
        top,
        height: Math.max(240, bottom - top),
        left: box.left,
        width: box.width,
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
  }, [panelOpen, detailMode]);
  const panelStyle = dock;

  const domainCoverage = useMemo(() => {
    if (!sessionData.ready) return null;
    const clipped = clipSessions(
      sessionData.sessions,
      range.start.getTime() / 1000,
      range.end.getTime() / 1000,
    ).filter((session) => !session.isAfk);
    return browserDomainCoverage(clipped, meta.browserSet);
  }, [sessionData.ready, sessionData.sessions, range.start, range.end, meta.browserSet]);
  const showDomainHint = domainCoverage !== null
    && shouldShowDomainCoverageHint(domainCoverage)
    && meta.settings.domain_coverage_hint_dismissed !== "1"
    // Nothing to report to a reader who has switched website recording off:
    // browser time carries no domain because they asked for that.
    && meta.settings.record_browser_domains !== "0";

  /**
   * The other half of the browser problem. `showDomainHint` covers the reader
   * whose browser time is not split at all; this covers the one whose *is*.
   *
   * Classifying chrome.exe as Browsing is the correct move and quietly the
   * wrong conclusion: every site inside it inherits that category, so a reader
   * who never learns websites classify separately reads their own YouTube and
   * their own docs as one undifferentiated blob and assumes Time cannot tell
   * them apart. Nothing on the screen says otherwise, because the app row they
   * just classified now looks finished.
   *
   * Conditions, all necessary: websites are actually being recorded (otherwise
   * this is advice they cannot take, and the extension hint is the right one), a
   * browser is classified (otherwise the misconception has not formed), and no
   * website rule exists yet (one proves they have evidently found the idea).
   */
  const needsWebsiteRuleGuidance = useMemo(() => {
    if (domainCoverage === null) return false;
    return shouldShowWebsiteRuleHint(
      domainCoverage,
      meta.rules.some(
        (rule) => rule.matchType === "process" && meta.browserSet.has(rule.pattern.toLowerCase()),
      ),
      meta.rules.some((rule) => rule.matchType === "domain"),
    );
  }, [domainCoverage, meta.rules, meta.browserSet]);

  const showWebsiteSignal =
    domainCoverage !== null
    && websiteSignalConfirmed(domainCoverage)
    && meta.settings.website_signal_seen !== "1";

  // When success and guidance coincide, the confirmation carries the next
  // action. Otherwise dismissing one notice immediately replaces it with an
  // almost identical one. A later browser classification still receives the
  // lighter inline prompt below the filters.
  const showWebsiteRuleHint =
    needsWebsiteRuleGuidance
    && !showWebsiteSignal
    && meta.settings.website_rule_guidance_seen !== "1";

  const refreshMeta = async () => {
    await meta.refresh();
  };

  // Persisted rather than component-local: successful tracking is a one-time
  // transition, and a confirmation that reappeared on the next launch would
  // stop reading as news. These are onboarding metadata, deliberately outside
  // DEFAULT_USER_SETTINGS, so restoring settings does not restart onboarding.
  const [dismissingSignal, setDismissingSignal] = useState(false);
  const [dismissingWebsiteRuleHint, setDismissingWebsiteRuleHint] = useState(false);
  const acknowledgeWebsiteSignal = async (showWebsites: boolean) => {
    setDismissingSignal(true);
    try {
      await updateSetting("website_signal_seen", "1");
      // The combined notice has already taught website-level classification.
      // Mark that guidance seen too, so it cannot turn into a second banner as
      // soon as this one closes.
      if (showWebsites) await updateSetting("website_rule_guidance_seen", "1");
      if (showWebsites) {
        setTypeFilter("website");
        setClassificationFilter("all");
      }
      await meta.refresh();
    } catch (cause) {
      banner.report(cause, "acknowledging the website notice");
      setDismissingSignal(false);
    }
  };
  const dismissWebsiteRuleHint = async () => {
    setDismissingWebsiteRuleHint(true);
    try {
      await updateSetting("website_rule_guidance_seen", "1");
      await meta.refresh();
    } catch (cause) {
      banner.report(cause, "dismissing the website classification hint");
      setDismissingWebsiteRuleHint(false);
    }
  };
  // A reader who is not going to install the extension has to be able to stop
  // being told about it. Without this the notice was permanent for them: the
  // condition it tests is exactly the condition their decision creates, so it
  // could never retire on its own. Retires for good rather than per-session --
  // declining an extension is not a thing to be asked again every launch.
  const [dismissingDomainHint, setDismissingDomainHint] = useState(false);
  const dismissDomainHint = async () => {
    setDismissingDomainHint(true);
    try {
      await updateSetting("domain_coverage_hint_dismissed", "1");
      await meta.refresh();
    } catch (cause) {
      banner.report(cause, "dismissing the website detection hint");
      setDismissingDomainHint(false);
    }
  };
  const { applySuggestions, assignEntity, assignFromTriage, removeExactRules } =
    useEntityRuleWrites(result?.triage.total ?? 0);
  // Apps the reader has already turned down. Persisted for the reason the
  // consolidation notice persists its own: a suggestion that comes back after
  // being dismissed is what makes the next one not worth reading.
  const dismissedSuggestions = useMemo(
    () => parseDismissed(meta.settings.starter_suggestions_dismissed),
    [meta.settings.starter_suggestions_dismissed],
  );
  // Offered against every pending app, not the five the section lists: the
  // review sheet exists to sweep the tail.
  const starterSuggestions = useMemo(
    () =>
      result
        ? suggestForTriage(
          result.triage.pendingApps,
          meta.categories,
          dismissedSuggestions,
          meta.browserSet,
        )
        : [],
    [result, meta.categories, dismissedSuggestions, meta.browserSet],
  );
  const suggestionByItemId = useMemo(
    () => new Map(starterSuggestions.map((suggestion) => [suggestion.entity.id, suggestion])),
    [starterSuggestions],
  );
  const [reviewingSuggestions, setReviewingSuggestions] = useState(false);


  const dismissSuggestion = async (item: ActivityTriageItem) => {
    try {
      await updateSetting(
        "starter_suggestions_dismissed",
        serializeDismissed([...dismissedSuggestions, suggestionKey(item)]),
      );
      await refreshMeta();
    } catch (error) {
      banner.report(error, "rule suggestion");
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
  const toggle = (set: Setter<Set<number>>) => (id: number) => set((current) => {
    return toggleSetValue(current, id);
  });
  const togglePanelSession = toggle(setPanelSessionIds);
  /** A Window detail action names the complete group explicitly, so selecting
   *  all includes every represented visit even though only a recent sample is
   *  carried for individual inspection. */
  const toggleAll = (set: Setter<Set<number>>) => (ids: number[]) => set((current) => {
    return toggleSetValues(current, ids);
  });
  const toggleAllPanelSessions = toggleAll(setPanelSessionIds);
  const toggleWindow = (group: ActivityTitleGroup) => setSelectedWindowKeys((current) => {
    return toggleSetValue(current, group.key);
  });
  const toggleWindows = (groups: ActivityTitleGroup[]) => setSelectedWindowKeys((current) => {
    return toggleSetValues(current, groups.map((group) => group.key));
  });
  /** The visits behind the selected windows. Read from the rows on screen, so a
   *  key left over from a window the current page no longer carries contributes
   *  nothing rather than acting on visits nobody can see. */
  const selectedWindowSessionIds = (): { ids: number[]; windows: number } => {
    const rows = (currentResult?.detailGroups.rows ?? []).filter(
      (group) => selectedWindowKeys.has(group.key),
    );
    return { ids: rows.flatMap((group) => group.sessionIds), windows: rows.length };
  };
  /**
   * Reclassify the ticked visits, without writing a rule.
   *
   * Every count in the banner comes from the write itself rather than from the
   * selection: visits already in the target category are not changes, and AFK
   * rows and the live session cannot be edited at all. Saying "40 visits" over
   * a batch that moved four would be the one sentence a reader has to trust.
   *
   * The selection survives, because the rows do — unlike a deletion, the
   * obvious next act is picking a different category for the same visits.
   */
  const classifySelection = async (ids: Set<number>, categoryId: number | null) => {
    const safeIds = restrictActivitySessionIds(ids, currentResult);
    if (safeIds.size === 0) return;
    const name = categoryId === null
      ? null
      : meta.categories.find((category) => category.id === categoryId)?.name;
    try {
      const outcome = await classifySessions([...safeIds], categoryId);
      const moved = outcome.previous.length;
      const subject = countNoun(moved, "visit");
      const skipped = outcome.skippedCount > 0
        ? ` ${countNoun(outcome.skippedCount, "visit")} could not be edited: AFK time and the live session are fixed.`
        : "";
      if (moved === 0) {
        banner.show(
          (outcome.skippedCount > 0
            ? "Nothing was reclassified."
            : `Already ${name === null ? "classified by rule" : `in ${name}`}.`)
          + skipped,
        );
        return;
      }
      banner.show(
        (name === null
          ? `${subject} returned to automatic classification.`
          : `${subject} reclassified as ${name}.`)
        + skipped,
        { label: "Undo", run: () => void undoClassification(outcome.previous) },
      );
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  /** The same two verbs as the Window panel, one level up. A window stands for
   *  every visit to it, so both act on the visits the ticked rows represent. */
  const classifySelectedWindows = (categoryId: number | null) => {
    const { ids } = selectedWindowSessionIds();
    void classifySelection(new Set(ids), categoryId);
  };
  const deleteSelectedWindows = () => {
    const { ids, windows } = selectedWindowSessionIds();
    requestSessionDeletion(
      new Set(ids),
      `${countNoun(windows, "selected window")} · ${countNoun(ids.length, "visit")}`,
    );
  };

  /** Each visit goes back to its own previous category, which is rarely the
   *  one category the batch replaced them all with. */
  const undoClassification = async (previous: SessionClassification[]) => {
    try {
      await restoreSessionClassifications(previous);
    } catch (error) {
      banner.report(error, "classification");
    }
  };

  /** `label` names the scope in the reader's own terms. A batch chosen by
   *  window was never picked visit by visit, and a confirmation that reported
   *  "412 selected visits" would be describing an act nobody performed. */
  const requestSessionDeletion = (ids: Set<number>, label?: string) => {
    const safeIds = restrictActivitySessionIds(ids, currentResult);
    if (safeIds.size === 0) return;
    setDeleteScope({
      request: { mode: "sessions", sessionIds: [...safeIds] },
      label: label ?? `${safeIds.size} selected visit${safeIds.size === 1 ? "" : "s"}`,
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
    setSelectedWindowKeys(new Set());
    if (closeEntity) {
      setWindowOrigin(null);
      setSelectedWindow(null);
      setSelectedEntityId(null);
    }
  };
  const openEntity = (entityId: string) => {
    setPanelSessionIds(new Set());
    setWindowOrigin(null);
    setSelectedWindow(null);
    setSelectedEntityId(entityId);
  };
  const openWindow = (
    group: ActivityTitleGroup,
    origin: "library" | "entity-detail",
  ) => {
    setPanelSessionIds(new Set());
    setSelectedEntityId(group.entityId);
    setWindowOrigin(origin);
    setSelectedWindow(group);
  };
  const openWindowParent = () => {
    setPanelSessionIds(new Set());
    setWindowOrigin(null);
    setSelectedWindow(null);
  };
  // The panel describes a row in the Library. Carrying it across to Categories
  // & Rules left it beside a list that could not have opened it.
  const switchView = (next: ActivityView) => {
    onViewChange(next);
    setPanelSessionIds(new Set());
    setWindowOrigin(null);
    setSelectedWindow(null);
    setSelectedEntityId(null);
  };

  if (!meta.loaded || (!result && (sessionData.loading || analyzed.refreshing))) return <Spinner />;
  const error = sessionData.error ?? analyzed.error;
  if (error && !result) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const showingExclusions = classificationFilter === "excluded";
  // Read from the same triage the section renders, not recounted: the two are
  // the same backlog seen from the card's two faces, and a header that
  // disagreed with the list one click away would be worse than no header.
  const pendingTriage = result?.triage.total ?? 0;
  const hasActiveLibraryFilters = typeFilter !== "all" || classificationFilter !== "all";
  const clearLibraryFilters = () => {
    setTypeFilter("all");
    setClassificationFilter("all");
  };
  const detailPanel = currentWindow ? (
    <WindowPanel
      dock={detailMode === "outboard" ? panelStyle : null}
      group={currentWindow}
      usage={result?.selectedWindowUsage ?? []}
      rangeDays={calendarDays(range)}
      onLoadMoreVisits={() => setWindowVisitLimit((limit) => limit + WINDOW_VISIT_MORE)}
      actionsDisabled={!analyzed.current}
      selectedSessionIds={panelSessionIds}
      onToggleSession={togglePanelSession}
      onToggleAllSessions={toggleAllPanelSessions}
      onClassifySelected={(categoryId) => void classifySelection(panelSessionIds, categoryId)}
      onDeleteSelected={() => requestSessionDeletion(panelSessionIds)}
      onEditSession={(id) => { if (currentSessionIds.has(id)) setEditingSessionId(id); }}
      categories={meta.categories}
      onMakeRule={(group) => {
        if (currentResult?.selectedWindow?.key === group.key) setRuleDraft(group);
      }}
      onOpenParent={openWindowParent}
      onBack={windowOrigin === "entity-detail" ? openWindowParent : undefined}
      onClose={closeActivityDetail}
    />
  ) : result?.selectedEntity ? (
    <EntityPanel
      dock={detailMode === "outboard" ? panelStyle : null}
      entity={result.selectedEntity}
      actionsDisabled={!analyzed.current}
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
      onClose={closeActivityDetail}
      categories={meta.categories}
      rules={meta.rules}
      aliases={meta.aliases}
      onDeleteEntity={() => {
        if (currentResult?.selectedEntity?.id === result.selectedEntity!.id) {
          requestEntityDeletion(result.selectedEntity!);
        }
      }}
      onExclude={() => {
        if (currentResult?.selectedEntity?.id !== result.selectedEntity!.id) return;
        setExcludeScope({
          kind: result.selectedEntity!.kind === "app" ? "app" : "website",
          pattern: result.selectedEntity!.key,
          label: result.selectedEntity!.displayName,
        });
      }}
      onOpenWindow={(group) => openWindow(group, "entity-detail")}
      selectedWindowKeys={selectedWindowKeys}
      onToggleWindow={toggleWindow}
      onToggleWindows={toggleWindows}
      onClassifyWindows={classifySelectedWindows}
      onDeleteWindows={deleteSelectedWindows}
      onAssign={(categoryId) => currentResult?.selectedEntity?.id === result.selectedEntity!.id
        ? assignEntity(result.selectedEntity!, categoryId)
        : Promise.resolve()}
      onSaveAlias={(alias) => currentResult?.selectedEntity?.id === result.selectedEntity!.id
        ? saveAlias(result.selectedEntity!.key, alias)
        : Promise.resolve()}
      onRemoveExactRule={() => currentResult?.selectedEntity?.id === result.selectedEntity!.id
        ? removeExactRules(result.selectedEntity!)
        : Promise.resolve()}
    />
  ) : null;
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-4"
      aria-busy={analyzed.refreshing || sessionData.refreshing}
    >
      {view === "library" && showDomainHint && (
        <section className="shrink-0 rounded-[12px] border border-accent/20 bg-accent/[.045] px-4 py-3 text-xs text-ink-2">
          <p>
            Browser time is not being split by website. Time reads websites from browser window
            titles; install the first-party Time Web Extension to add that signal.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <ExtensionLinks />
            <Button disabled={dismissingDomainHint} onClick={() => void dismissDomainHint()}>
              {dismissingDomainHint ? "Saving…" : "Don't show again"}
            </Button>
          </div>
        </section>
      )}

      {view === "library" && showWebsiteSignal && (
        <section className="shrink-0 rounded-[12px] border border-accent/20 bg-accent/[.045] px-4 py-3 text-xs text-ink-2">
          <p>
            <span className="font-medium text-ink">Website tracking is working.</span>{" "}
            {needsWebsiteRuleGuidance ? (
              <>
                Time is now separating your browser time by site. Websites can have their own
                categories—select one below, then choose a category under Classification.
              </>
            ) : (
              <>Time is splitting your browser time by site. Websites now appear here alongside your apps.</>
            )}
          </p>
          <div className="mt-2.5">
            <Button
              disabled={dismissingSignal}
              onClick={() => void acknowledgeWebsiteSignal(needsWebsiteRuleGuidance)}
            >
              {dismissingSignal ? "Saving…" : needsWebsiteRuleGuidance ? "Show websites" : "Got it"}
            </Button>
          </div>
        </section>
      )}

      {/* The card is measured, not shrunk. The panel docks against its right
          edge from outside the page container, so opening one leaves the table
          exactly the width it has on every other tab. */}
      <div
        ref={cardRef}
        className={`flex min-h-0 ${
          view === "library"
            ? "flex-1"
            // Categories & Rules is a settings surface, not a data surface: a
            // name, a state and a count, with half a screen of air between them
            // at full width. The floor is the Window-rule composer — its
            // "Applies to" row plus a scope input, inside the rule indent. An
            // 800px cap keeps that row flat without stretching the folded list.
            // mr-auto, not mx-auto: centring would slide the view switcher out
            // from under the cursor that just clicked it.
            : "mr-auto w-full max-w-[800px]"
        }`}
      >
      {detailMode === "drill-in" && panelOpen ? detailPanel : (
      <>
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
          // Export only. The noise-fold link used to sit here too, and moved
          // down beside the filters once the Unclassified section arrived: it
          // shapes the table, not the card, and it was landing one line above a
          // different "Show" that meant something else entirely. The header
          // keeps what acts on the card as a whole.
          <span className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
            {source && result && (
              <ActivityExportMenu
                source={source}
                range={range}
                hasStoredTitles={result.hasStoredTitles}
              />
            )}
          </span>
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-ink-3">
            <span>{meta.categories.length} categories · {meta.rules.length} rules</span>
            {/* The backlog's only route out of this face. The tab's mark cannot
                serve it: both faces share a tab, so while this one is up the
                mark is on the tab already being read. Text in the header rather
                than a second mark on the switcher — a badge pointing at a
                control that is one click away and already visible is a chain
                that says nothing the count does not. Counted like the section
                itself, from one item: the tab's mark holds out for an hour
                because it interrupts a different tab, and this does not. */}
            {pendingTriage > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => switchView("library")}
                  title="Show these in Apps & Websites"
                  className="tabular-nums underline-offset-2 hover:text-ink-2 hover:underline"
                >
                  {pendingTriage} unclassified
                </button>
              </>
            )}
          </span>
        )}
      >
        {view === "library" ? (
          <>
            {/* Above the controls, deliberately: it answers to none of them,
                and it reads over all of history while the table below reads
                the selected range. */}
            {!showingExclusions && result && (
              <UnclassifiedSection
                triage={result.triage}
                categories={meta.categories}
                suggestionByItemId={suggestionByItemId}
                suggestionCount={starterSuggestions.length}
                onReview={() => setReviewingSuggestions(true)}
                onAssign={assignFromTriage}
                onShowAll={() => {
                  setClassificationFilter("uncategorized");
                  if (!isAllTime) onTryAllTime();
                }}
              />
            )}
            <LibraryControls
              search={search}
              onSearch={setSearch}
              typeFilter={typeFilter}
              onTypeFilter={setTypeFilter}
              classificationFilter={classificationFilter}
              onClassificationFilter={setClassificationFilter}
              categories={meta.categories}
              uncategorizedCount={result?.uncategorized.entities ?? 0}
              noiseHidden={showingExclusions ? 0 : (result?.noiseHidden ?? 0)}
              includeNoise={includeNoise}
              onIncludeNoise={() => setIncludeNoise((shown) => !shown)}
            />
            {showWebsiteRuleHint && (
              <div className="-mt-1 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                <p>
                  Websites can have their own categories.{" "}
                  {typeFilter === "website" && classificationFilter !== "excluded" ? (
                    <>Select one, then choose a category under Classification.</>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setTypeFilter("website");
                          setClassificationFilter("all");
                        }}
                        className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                      >
                        Show websites
                      </button>{" "}
                      to select one, then choose a category under Classification.
                    </>
                  )}
                </p>
                <button
                  type="button"
                  disabled={dismissingWebsiteRuleHint}
                  onClick={() => void dismissWebsiteRuleHint()}
                  className="shrink-0 text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline disabled:cursor-wait disabled:no-underline"
                >
                  {dismissingWebsiteRuleHint ? "Saving…" : "Dismiss"}
                </button>
              </div>
            )}
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
                      onSort={(next) => updateSortState(next, sort, direction, "name", setSort, setDirection)}
                      windowSort={windowSort}
                      windowDirection={windowDirection}
                      onWindowSort={(next) => updateSortState(
                        next,
                        windowSort,
                        windowDirection,
                        "title",
                        setWindowSort,
                        setWindowDirection,
                      )}
                      selectedEntityId={selectedEntityId}
                      selectedWindowKey={currentWindow?.key ?? null}
                      onSelectEntity={openEntity}
                      onSelectWindow={(group) => openWindow(group, "library")}
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
                      onSort={(next) => updateSortState(next, sort, direction, "name", setSort, setDirection)}
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
          <CategoriesAndRules
            source={source}
            ruleUsageSeconds={result?.ruleUsageSeconds ?? null}
            onChanged={refreshMeta}
          />
        )}
      </Card>
      </>
      )}
      </div>

      {detailMode === "outboard" ? detailPanel : null}

      {reviewingSuggestions && (
        <StarterSuggestionDialog
          suggestions={starterSuggestions}
          categories={meta.categories}
          pendingTotal={result?.triage.total ?? 0}
          onClose={() => setReviewingSuggestions(false)}
          // Turning down the last row leaves nothing to review, and a dialog
          // that stayed open on an empty list with a disabled button would make
          // the reader find their own way out of a screen they just finished.
          onDismiss={async (item) => {
            if (starterSuggestions.length <= 1) setReviewingSuggestions(false);
            await dismissSuggestion(item);
          }}
          onApply={async (accepted) => {
            setReviewingSuggestions(false);
            await applySuggestions(accepted);
          }}
        />
      )}
      {deleteScope && (
        <DeleteActivityDialog
          scope={deleteScope}
          onClose={() => setDeleteScope(null)}
          onDeleted={(request) => {
            setDeleteScope(null);
            if (request.mode === "sessions" && currentWindow) {
              const deletedIds = new Set(request.sessionIds);
              if (currentWindow.sessionIds.every((id) => deletedIds.has(id))) {
                if (windowOrigin === "entity-detail") openWindowParent();
                else closeActivityDetail();
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
