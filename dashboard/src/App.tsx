import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import DateRangePicker, { type PresetOrCustom } from "./components/DateRangePicker";
import { Spinner } from "./components/ui";
import {
  DbErrorScreen,
  FirstRunPanel,
  NewerDatabaseScreen,
  PrivacyOnboarding,
  TrackerAlert,
  WaitingForTracker,
} from "./components/AppStates";
import { isMissingSchemaError } from "./lib/dbErrors";
import {
  currentHistoryRevision,
  invalidateHistory,
  subscribeHistoryInvalidation,
} from "./lib/historyInvalidation";
import {
  fetchEarliestSessionStart,
  fetchTrackerStatus,
  takeRestoreNotice,
  type TrackerStatus,
} from "./lib/queries";
import { isNewerSchemaError } from "./lib/schema";
import { trackerNeedsAttention } from "./lib/trackerHealth";
import {
  allTimeRange,
  clampRangeStart,
  isRollingPreset,
  rangeForCalendarPreset,
  rangeForPreset,
  type Range,
} from "./lib/time";
import {
  BACKLOG_BADGE_SECONDS,
  backlogOnlyQuery,
  type ActivitySource,
} from "./lib/activity";
import { downloadPercent, updateButtonLabel, type AvailableUpdate, type UpdateProgress } from "./lib/appUpdate";
import { BannerProvider, useBanner } from "./state/banner";
import { useAppUpdate } from "./state/useAppUpdate";
import { MetaProvider, useMeta } from "./state/meta";
import { useActivityModel } from "./state/useActivityModel";
import { useInsightsView } from "./state/useInsightsView";
import { useLiveRefresh } from "./state/useLiveRefresh";
import { useSessions } from "./state/useSessions";
import ActivityTab, { type ActivityView } from "./tabs/ActivityTab";
import OverviewTab from "./tabs/OverviewTab";
import SettingsTab from "./tabs/SettingsTab";

type Tab = "insights" | "activity" | "settings";

/** Ties the Activity tab to its backlog hint without putting the hint inside
 *  the button, where it would become part of the tab's accessible name. */
const BACKLOG_HINT_ID = "activity-backlog-hint";

/** One sentence, spent twice — as the tab's description and as its tooltip — so
 *  the dot means the same thing however a reader arrives at it. */
const BACKLOG_HINT = "Unclassified activity is waiting";

const TABS: { id: Tab; label: string }[] = [
  { id: "insights", label: "Insights" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  return (
    <MetaProvider>
      <BannerProvider>
        <Shell />
      </BannerProvider>
    </MetaProvider>
  );
}
function Shell() {
  const meta = useMeta();
  const banner = useBanner();
  const [tab, setTab] = useState<Tab>("insights");
  // This view also decides whether the global date picker is relevant. Keeping
  // it above the tab switch prevents the picker flashing back while Activity
  // remounts, and preserves the reader's place when they briefly visit Settings.
  const [activityView, setActivityView] = useState<ActivityView>("library");
  // A one-shot handoff, not lifted filter state: Settings' exclusion count can
  // send the reader to the list that owns exclusions, and Activity clears the
  // request once it has mounted with it so a later tab switch lands normally.
  const [openExclusions, setOpenExclusions] = useState(false);
  // Same one-shot shape as openExclusions: a control elsewhere can send the
  // reader to a specific section of Settings, and Settings clears the request
  // once it has acted on it.
  const [highlightSection, setHighlightSection] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetOrCustom>("last7");
  const [rolling, setRolling] = useState(true);
  const [customRange, setCustomRange] = useState<Range | null>(null);
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [firstSessionSec, setFirstSessionSec] = useState<number | null>(null);
  const [historyRevision, setHistoryRevision] = useState(currentHistoryRevision);
  /** The last session count this session-count poll observed, so the 0 → n
   *  transition can be told apart from a first reading on a populated database. */
  const sessionCountRef = useRef<number | null>(null);
  // Insights view controls live here, above the tab switch, so a change made on
  // the Insights tab survives leaving for another tab and coming back.
  const insightsView = useInsightsView();
  const liveTick = useLiveRefresh();

  useEffect(() => {
    void takeRestoreNotice()
      .then((notice) => {
        if (!notice) return;
        if (notice.ok) banner.show(notice.message);
        else banner.report(new Error(notice.message));
      })
      .catch(() => {});
  }, [banner]);

  // liveTick is a dependency for its timing, not its value: every preset here
  // except "custom" is anchored on today, and nothing else in this memo changes
  // when the date does. Without it, an app left open overnight keeps reporting
  // yesterday as "Today" until something unrelated re-renders.
  const range = useMemo<Range>(() => {
    if (preset === "custom") return customRange ?? rangeForPreset("last7");
    if (preset === "alltime") return allTimeRange(firstSessionSec);
    const fixed = !rolling && isRollingPreset(preset)
      ? rangeForCalendarPreset(preset, meta.weekStart)
      : rangeForPreset(preset);
    return clampRangeStart(fixed, firstSessionSec);
  }, [preset, rolling, customRange, firstSessionSec, meta.weekStart, liveTick]);

  // An empty DB (the tracker hasn't run yet) is a waiting state, not an
  // error. Retry until the tracker's first bootstrap creates the schema.
  const waitingForTracker = meta.loaded && meta.error !== null && isMissingSchemaError(meta.error);
  useEffect(() => {
    if (!waitingForTracker) return;
    const id = setInterval(() => void meta.refresh(), 5000);
    return () => clearInterval(id);
  }, [waitingForTracker, meta.refresh]);

  // First-run panel data: poll tracker status only until the first session exists.
  const ready = meta.loaded && meta.error === null;

  // Gated on `ready` so the check waits for settings to load — the opt-out and
  // the onboarding flag both live there, and asking before they arrive would
  // read an empty object as consent.
  const reportUpdateFailure = useCallback(
    (error: unknown) => banner.report(error, "installing the update"),
    [banner],
  );
  const update = useAppUpdate(meta.settings, ready, reportUpdateFailure);

  const refreshFirstSession = useCallback(async () => {
    const first = await fetchEarliestSessionStart();
    setFirstSessionSec(first);
  }, []);

  const refreshTrackerStatus = useCallback(async () => {
    setStatus(await fetchTrackerStatus());
  }, []);

  useEffect(() => subscribeHistoryInvalidation((revision) => {
    setHistoryRevision(revision);
    void refreshFirstSession().catch(() => {});
    void fetchTrackerStatus().then(setStatus).catch(() => {});
  }), [refreshFirstSession]);

  // Earliest session, for the "All time" range. Re-read while the DB is still
  // empty so the preset works as soon as the first session lands.
  useEffect(() => {
    if (!ready || firstSessionSec !== null) return;
    const load = () => void refreshFirstSession().catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [ready, firstSessionSec, refreshFirstSession]);
  // The welcome panel outlives the empty database it used to be gated on. Its
  // old gate was `totalSessionCount === 0`, so the panel announced that the
  // first activity was about to arrive and was then destroyed by that arrival —
  // usually inside a minute, before a new reader had finished it. Dismissal is
  // now the only thing that ends it.
  const welcomeVisible = status !== null && meta.settings.welcome_dismissed !== "1";
  // Depend on the answer, not on `status` itself. fetchTrackerStatus resolves a
  // new object every time, so keeping `status` in the dependency list tore this
  // effect down and rebuilt it on every poll — and because the body starts with
  // an immediate load(), each rebuild issued another query at once. On a
  // database with no sessions the guard below never fires, so that ran as an
  // unbounded loop: roughly twelve hundred queries a second, for as long as a
  // fresh install went without its first session.
  const awaitingFirstSession = status === null || status.totalSessionCount === 0;
  // Keep polling while the welcome panel is up, even once sessions exist: the
  // panel shows a live/stopped dot, and a dot that stopped refreshing when the
  // first session landed would report a tracker state minutes out of date.
  useEffect(() => {
    if (!ready || (!awaitingFirstSession && !welcomeVisible)) return;
    let cancelled = false;
    const load = () =>
      void fetchTrackerStatus()
        .then((s) => {
          if (cancelled) return;
          // The tracker writes sessions straight to SQLite and has no way to
          // tell the renderer. This poll is the only thing watching, so the
          // moment it sees a count leave zero is the app's one chance to drop
          // the caches built while the database was empty — otherwise the
          // reader is left on an empty Insights tab that only fills in once
          // something remounts it.
          //
          // Compare against the previous observation rather than a "have I
          // fired yet" flag: on a database that already has history the first
          // reading is a large number, and treating that as the transition
          // would clear every cache on each launch.
          const previousCount = sessionCountRef.current;
          sessionCountRef.current = s.totalSessionCount;
          setStatus(s);
          if (previousCount === 0 && s.totalSessionCount > 0) invalidateHistory();
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready, awaitingFirstSession, welcomeVisible]);

  // The health signal behind TrackerAlert. The poll above stops once the first
  // session exists and the welcome panel is gone, which is exactly when a
  // tracker is most likely to die unnoticed — after a reboot, weeks in. A minute
  // is far below the two-minute staleness bar, so the warning appears within one
  // tick of becoming true. `liveTick` re-checks on the way back to the app, for
  // the reader who returns before the tick lands.
  // Booleans and numbers in the dependency list only: fetchTrackerStatus
  // resolves a fresh object each time, and depending on `status` would rebuild
  // this effect on every response and re-fire its immediate load.
  useEffect(() => {
    if (!ready) return;
    const load = () => void fetchTrackerStatus().then(setStatus).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [ready, liveTick]);

  const heartbeatAgeSec = status?.lastHeartbeat == null || status.lastHeartbeat <= 0
    ? null
    : Date.now() / 1000 - status.lastHeartbeat;
  // Never before the first status read: `status === null` is "not asked yet",
  // and treating it as "never checked in" would flash the warning on every
  // launch in the gap before the first answer arrives.
  // Suppressed wherever the same news is already on screen, and nowhere else.
  // That is Insights while the welcome panel is up — not wherever the panel is
  // merely undismissed, which silenced this for every new reader who had not yet
  // pressed "Got it" — and Settings, whose Tracker status panel says the same
  // thing at the top of the page, with an animated dot and its own start button.
  // Repeating it there stacks two warnings about one fact.
  const trackerAlertVisible =
    ready
    && status !== null
    && tab !== "settings"
    && !(welcomeVisible && tab === "insights")
    && trackerNeedsAttention({
      heartbeatAgeSec,
      settings: meta.settings,
      nowSec: Date.now() / 1000,
    });

  // The backlog behind the Activity tab's mark. It lives here rather than in
  // ActivityTab because the reader who most needs telling is the one who has
  // never opened that tab — and an unmounted tab cannot report anything. The
  // window is the same all-time one ActivityTab asks for, so the session cache
  // serves both from one fetch, and the worker reuses its index across them.
  const backlogRange = useMemo(
    () => allTimeRange(firstSessionSec),
    [firstSessionSec, historyRevision, liveTick],
  );
  const backlogSessions = useSessions(
    backlogRange.start.getTime() / 1000,
    backlogRange.end.getTime() / 1000,
    historyRevision,
    liveTick,
  );
  const backlogSource = useMemo<ActivitySource | null>(() => {
    if (!backlogSessions.ready) return null;
    return {
      sessions: backlogSessions.sessions,
      categories: meta.categories,
      rules: meta.rules,
      browserProcesses: [...meta.browserSet].sort(),
      aliases: meta.aliases,
    };
  }, [backlogSessions.ready, backlogSessions.sessions, meta.categories, meta.rules, meta.aliases, meta.browserSet]);
  const backlogQuery = useMemo(() => backlogOnlyQuery(meta.noisePolicy), [meta.noisePolicy]);
  const backlog = useActivityModel(backlogSource, backlogQuery);
  const showBacklogBadge = (backlog.result?.triage.seconds ?? 0) >= BACKLOG_BADGE_SECONDS;

  if (!meta.loaded) return <Spinner label="Connecting to database..." />;
  if (waitingForTracker) return <WaitingForTracker />;
  if (meta.error && isNewerSchemaError(meta.error)) return <NewerDatabaseScreen />;
  if (meta.error) return <DbErrorScreen error={meta.error} />;
  if (meta.settings.privacy_onboarding_complete !== "1") return <PrivacyOnboarding />;

  const showRange =
    tab === "insights" || (tab === "activity" && activityView === "library");

  // Activity bounds its own scroll wells, and a percentage of an auto height
  // resolves to auto: without a definite height here, its "fill the leftover
  // space" simply grew the page instead. Both of its views scroll internally,
  // so the page itself is held shut — there is nothing below the fold to reach
  // and a drag that moved the header off screen would only ever be a bug.
  // The other tabs keep min-height, which lets them run past the viewport and
  // scroll with their padding intact.
  const bounded = tab === "activity";

  // One width for every tab, deliberately: the date range picker sits at the
  // top right of both Insights and Activity, and a tab that measured itself
  // differently moved that control when the reader switched between them.
  // Activity's detail panel docks in the margin beside this container instead
  // of taking width from it — see the panel's own note.
  // Top padding is smaller than the rest because the custom title bar already
  // sits above in the page's own background colour, so its 32px reads as
  // padding rather than chrome. It is not zero: on a min-width window the range
  // picker's right edge lands under the caption controls and needs clearance.
  return (
    <div
      className={`time-shell mx-auto flex max-w-6xl flex-col gap-4 px-3 pt-2 pb-5 sm:px-6 ${bounded ? "h-full overflow-hidden" : "min-h-full"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <TabBar tab={tab} onTab={setTab} backlog={showBacklogBadge} />
          {update.available && (
            <UpdateButton
              update={update.available}
              installing={update.installing}
              progress={update.progress}
              onInstall={update.install}
            />
          )}
        </div>
        {showRange && (
          <DateRangePicker
            preset={preset}
            range={range}
            rolling={rolling}
            onPreset={setPreset}
            onRollingChange={setRolling}
            onCustomRange={(r) => {
              setCustomRange(r);
              setPreset("custom");
            }}
          />
        )}
      </header>

      {/* Insights only. The panel used to appear on every tab, which cost
          nothing while it was gated on an empty database — there were no rows
          to push aside. Now that it persists until dismissed, that space is
          contested: at the 500x480 minimum it drove the Activity table's first
          row out of a region that scrolls internally, leaving it unreachable.
          Insights is also where it belongs, since it is the landing tab and its
          own advice is to go and look at Activity. */}
      {welcomeVisible && tab === "insights" && (
        <FirstRunPanel
          status={status}
          onRefreshStatus={refreshTrackerStatus}
          onOpenSettings={() => setTab("settings")}
        />
      )}

      {/* Every tab, unlike the welcome panel: a reader who is not looking at
          Insights is no less affected by a tracker that stopped, and this is
          short enough that the Activity table keeps its room. */}
      {trackerAlertVisible && <TrackerAlert onOpenSettings={() => setTab("settings")} />}

      {/* A flex column so a tab can opt into filling the leftover viewport
          height — Activity does, to bound its own scroll wells. Tabs that do
          not simply size to their content, as they did before. */}
      <main className="flex min-h-0 flex-1 flex-col">
        {tab === "insights" && (
          <OverviewTab
            range={range}
            preset={preset}
            firstSessionSec={firstSessionSec}
            view={insightsView}
            historyRevision={historyRevision}
            liveTick={liveTick}
            onOpenSettings={() => {
              setHighlightSection("Goals & time");
              setTab("settings");
            }}
          />
        )}
        {tab === "activity" && (
          <ActivityTab
            view={activityView}
            onViewChange={setActivityView}
            range={range}
            firstSessionSec={firstSessionSec}
            historyRevision={historyRevision}
            liveTick={liveTick}
            isAllTime={preset === "alltime"}
            onTryAllTime={() => setPreset("alltime")}
            openExclusions={openExclusions}
            onExclusionsOpened={() => setOpenExclusions(false)}
          />
        )}
        {tab === "settings" && (
          <SettingsTab
            onManageExclusions={() => {
              setActivityView("library");
              setOpenExclusions(true);
              setTab("activity");
            }}
            onManageCategories={() => {
              setOpenExclusions(false);
              setActivityView("rules");
              setTab("activity");
            }}
            highlightSection={highlightSection}
            onHighlightShown={() => setHighlightSection(null)}
          />
        )}
      </main>
    </div>
  );
}

/** Tab switcher whose selected pill slides between tabs instead of jumping. The
 *  pill is one absolutely positioned element measured off the button rects, so it
 *  tracks label widths and font/zoom changes rather than assuming equal tabs. */
function TabBar({
  tab,
  onTab,
  backlog,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Enough unclassified time to be worth a mark on the Activity tab. */
  backlog: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      const button = buttonRefs.current.get(tab);
      if (!list || !button) return;
      setPill({ left: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [tab]);

  return (
    <div
      ref={listRef}
      className="relative flex items-center gap-1 rounded-xl border border-edge bg-surface p-1"
    >
      {pill && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 bottom-1 rounded-lg bg-surface-2 transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)`, left: 0 }}
        />
      )}
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          ref={(node) => {
            if (node) buttonRefs.current.set(t.id, node);
            else buttonRefs.current.delete(t.id);
          }}
          onClick={() => onTab(t.id)}
          className={`relative rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
            tab === t.id ? "text-ink" : "text-ink-2 hover:text-ink"
          }`}
          aria-describedby={t.id === "activity" && backlog ? BACKLOG_HINT_ID : undefined}
          // The same sentence the hint below carries, for the reader who has
          // neither a screen reader to read it nor any other way to find out
          // what a bare dot means.
          title={t.id === "activity" && backlog ? BACKLOG_HINT : undefined}
        >
          {t.label}
          {/* A dot, not a count: the number belongs where you can act on it, and
              the Library's own section carries it. Absolutely positioned so the
              tab keeps its width — a label that grew when the mark appeared
              would shift the tabs beside it and move the sliding pill under the
              cursor that just clicked. */}
          {t.id === "activity" && backlog && (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent"
            />
          )}
        </button>
      ))}
      {/* Described, not renamed. This text sits outside the button on purpose:
          inside it, it would join the accessible name, and a tab that is called
          "Activity" while idle and something longer while work is pending is a
          different control to anyone finding it by name. */}
      {backlog && (
        <span id={BACKLOG_HINT_ID} className="sr-only">
          {BACKLOG_HINT}
        </span>
      )}
    </div>
  );
}

/**
 * The whole update affordance: present only when there is something to install,
 * and absent entirely the rest of the time. It sits beside the tab strip rather
 * than inside Settings because an update nobody finds is an update nobody
 * applies — and beside it rather than in it, because the sliding pill measures
 * itself off the tab buttons and a fourth child in that container would join
 * the row it is measuring.
 *
 * At rest it is the download glyph the CSV export uses, at the same weight. The
 * label appears on hover and on keyboard focus, over the header rather than
 * within it: the wrapper holds a fixed 28px square and the button is absolute
 * inside it, so nothing reflows when the label arrives. That is not fussiness —
 * every tab here is one width for the same reason, because the date picker at
 * the other end of this header moves when anything to its left changes size.
 */
function UpdateButton({
  update,
  installing,
  progress,
  onInstall,
}: {
  update: AvailableUpdate;
  installing: boolean;
  progress: UpdateProgress | null;
  onInstall: () => void;
}) {
  const label = updateButtonLabel(update, installing, progress);
  const percent = downloadPercent(progress);
  return (
    <div className="relative h-7 w-7 shrink-0">
      <button
        type="button"
        onClick={onInstall}
        disabled={installing}
        title={label}
        aria-label={label}
        className={`group absolute top-0 left-0 flex h-7 min-w-7 items-center justify-center rounded-lg px-1.5 whitespace-nowrap transition-colors motion-reduce:transition-none disabled:cursor-progress ${
          installing
            ? "bg-hover-2 text-ink-2"
            : "text-accent hover:bg-hover-2 focus-visible:bg-hover-2"
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
        {/* max-width rather than display, so the reveal can be animated and so
            the text stays in the accessible tree either way. */}
        <span
          aria-hidden="true"
          className={`overflow-hidden text-xs font-medium transition-all duration-150 motion-reduce:transition-none ${
            installing
              ? "ml-1.5 max-w-56 opacity-100"
              : "ml-0 max-w-0 opacity-0 group-hover:ml-1.5 group-hover:max-w-56 group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-56 group-focus-visible:opacity-100"
          }`}
        >
          {label}
        </span>
        {/* Measured against the button, not the 28px wrapper — the button is
            what grew. Absent until the endpoint declares a length, which is
            what tells the reader "working" from "half done". */}
        {installing && percent !== null && (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        )}
      </button>
    </div>
  );
}
