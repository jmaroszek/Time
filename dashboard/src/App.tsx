import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import DateRangePicker, { type PresetOrCustom } from "./components/DateRangePicker";
import { Spinner } from "./components/ui";
import {
  DbErrorScreen,
  NewerDatabaseScreen,
  OffScheduleNotice,
  PauseNotice,
  PrivacyOnboarding,
  RecordingOffPanel,
  StartRecordingPanel,
  TrackerAlert,
  WaitingForTracker,
  WelcomePanel,
} from "./components/AppStates";
import { isMissingSchemaError } from "./lib/dbErrors";
import {
  currentHistoryRevision,
  invalidateHistory,
  subscribeHistoryInvalidation,
} from "./lib/historyInvalidation";
import {
  fetchEarliestSessionStart,
  fetchSettings,
  fetchTrackerStatus,
  takeRestoreNotice,
  type TrackerStatus,
} from "./lib/queries";
import { isNewerSchemaError } from "./lib/schema";
import {
  bannerFor,
  bannerVisibleOnTab,
  readerIsNew,
  recordingState,
  TRACKER_ALERT_STALE_SECONDS,
  TRACKER_LAUNCH_GRACE_SECONDS,
} from "./lib/trackerHealth";
import {
  allTimeRange,
  calendarDays,
  clampRangeStart,
  clampCustomRange,
  rangesEqual,
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
    if (preset === "custom") {
      return clampCustomRange(customRange ?? rangeForPreset("last7"), firstSessionSec);
    }
    if (preset === "alltime") return allTimeRange(firstSessionSec);
    const fixed = !rolling && isRollingPreset(preset)
      ? rangeForCalendarPreset(preset, meta.weekStart)
      : rangeForPreset(preset);
    return clampRangeStart(fixed, firstSessionSec);
  }, [preset, rolling, customRange, firstSessionSec, meta.weekStart, liveTick]);

  useEffect(() => {
    if (!customRange) return;
    const clamped = clampCustomRange(customRange, firstSessionSec);
    if (!rangesEqual(clamped, customRange)) setCustomRange(clamped);
  }, [customRange, firstSessionSec, liveTick]);

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
  // Pause is written from the tray, outside every path that refreshes `meta`,
  // which loads once and re-reads only after a write from this window. Overlay
  // just those two keys from the status poll below: meta stays authoritative for
  // everything the dashboard itself owns, including the dismiss flags, so a
  // dismissal takes effect immediately rather than at the next poll.
  const [trayPause, setTrayPause] = useState<Record<string, string>>({});
  const trackerSettings = useMemo(
    () => ({ ...meta.settings, ...trayPause }),
    [meta.settings, trayPause],
  );
  // A start the reader just asked for, held here rather than inside the panel
  // that asked for it: the panel is mounted by the very state this flag
  // suppresses, so owning it there would unmount the timer mid-countdown.
  const [startPending, setStartPending] = useState(false);
  const [offerStartup, setOfferStartup] = useState(false);
  const [pauseNoticeDismissed, setPauseNoticeDismissed] = useState(false);
  // The launch grace, held as state flipped by a timer rather than computed from
  // a mount timestamp on each render: the alarm it defers has to appear when the
  // grace ends, and a rendered comparison only re-evaluates when something else
  // causes a render. On an established install with a genuinely dead tracker
  // nothing else would, and the warning would wait for the minute poll.
  //
  // Anchored to onboarding finishing rather than to this component mounting.
  // App renders the privacy screen itself, so mount happens while the reader is
  // still reading it — and a first-run reader spends far longer than the grace
  // there. The clock ran out before the dashboard existed, the tracker was only
  // asked to start at the end of that screen, and the first render after it
  // greeted a brand-new install with the alarm this grace exists to prevent.
  // On an established install the setting is already "1" at mount, so this runs
  // immediately and behaves exactly as an unconditional mount timer would.
  const onboardingComplete = meta.settings.privacy_onboarding_complete === "1";
  const [launchGraceOver, setLaunchGraceOver] = useState(false);
  useEffect(() => {
    if (!onboardingComplete) return;
    setLaunchGraceOver(false);
    const id = setTimeout(() => setLaunchGraceOver(true), TRACKER_LAUNCH_GRACE_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [onboardingComplete]);

  const heartbeatAgeSec = status?.lastHeartbeat == null || status.lastHeartbeat <= 0
    ? null
    : Date.now() / 1000 - status.lastHeartbeat;
  // Never before the first status read: `status === null` is "not asked yet",
  // and treating it as "never checked in" would flash a warning on every launch
  // in the gap before the first answer arrives.
  const trackerState = status === null
    ? null
    : recordingState({
      heartbeatAgeSec,
      settings: trackerSettings,
      nowSec: Date.now() / 1000,
      totalSessionCount: status.totalSessionCount,
      starting: startPending,
      launchGrace: !launchGraceOver,
    });
  // At most one banner, resolved from one state. Two surfaces reporting the same
  // fact used to be prevented by a suppression clause maintained by hand at each
  // call site; it is now impossible by construction.
  const bannerPlan = trackerState === null
    ? null
    : bannerFor(trackerState, {
      readerIsNew: readerIsNew(firstSessionSec, Date.now() / 1000),
      settings: trackerSettings,
      pauseNoticeDismissed,
    });
  const trackerBannerVisible = ready && bannerVisibleOnTab(bannerPlan, tab);
  // Both of these render a live tracker dot, so the status poll has to keep
  // running while either is up even once the first session exists.
  const panelWatchesTracker = bannerPlan?.id === "welcome"
    || bannerPlan?.id === "start_recording";
  // The states a reader is actively waiting to leave: the stopped alarm, a start
  // the tracker has not confirmed, and the launch grace during which nothing is
  // claimed at all. None was covered above, so all fell through to the minute
  // poll below, and a banner that outlives the tray icon and the Settings dot by
  // most of a minute reads as the button having done nothing. Each is transient
  // by construction -- `starting` and `unconfirmed` expire into `stopped`, and
  // `stopped` ends on the first stamp -- so the fast cadence cannot become the
  // resting state of an application that is working.
  const awaitingTrackerTransition = trackerState?.kind === "stopped"
    || trackerState?.kind === "starting"
    || trackerState?.kind === "unconfirmed";

  // A start that never confirms must not sit as "starting" forever, or the one
  // alarm worth interrupting for would be suppressed by the reader's own
  // attempt to fix it. The panel says so at TRACKER_CONFIRM_MS; this is the
  // outer bound after which the state falls through to `stopped`.
  useEffect(() => {
    if (!startPending) return;
    if (trackerState?.kind === "recording") {
      setStartPending(false);
      return;
    }
    const id = setTimeout(() => setStartPending(false), TRACKER_ALERT_STALE_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [startPending, trackerState?.kind]);

  // A new pause is a new announcement, even if the last one was dismissed.
  const pauseIdentity = trackerState?.kind === "paused" ? String(trackerState.until ?? "open") : "";
  useEffect(() => {
    setPauseNoticeDismissed(false);
  }, [pauseIdentity]);

  // Depend on the answer, not on `status` itself. fetchTrackerStatus resolves a
  // new object every time, so keeping `status` in the dependency list tore this
  // effect down and rebuilt it on every poll — and because the body starts with
  // an immediate load(), each rebuild issued another query at once. On a
  // database with no sessions the guard below never fires, so that ran as an
  // unbounded loop: roughly twelve hundred queries a second, for as long as a
  // fresh install went without its first session.
  const awaitingFirstSession = status === null || status.totalSessionCount === 0;
  // Keep polling while a tracker-state panel is up, even once sessions exist:
  // those panels show a live/stopped dot, and a dot that stopped refreshing when
  // the first session landed would report a tracker state minutes out of date.
  useEffect(() => {
    if (
      !ready
      || (!awaitingFirstSession && !panelWatchesTracker && !awaitingTrackerTransition)
    ) return;
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
    // The tracker stamps health every 5s and stamps once on startup, so two
    // seconds is the point past which a shorter interval stops buying anything:
    // what is being waited on is the stamp, not the read.
    const id = setInterval(load, awaitingTrackerTransition ? 2_000 : 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready, awaitingFirstSession, panelWatchesTracker, awaitingTrackerTransition]);

  // The health signal behind TrackerAlert. The poll above stops once the first
  // session exists and the welcome panel is gone, which is exactly when a
  // tracker is most likely to die unnoticed — after a reboot, weeks in. A minute
  // is far below the two-minute staleness bar, so the warning appears within one
  // tick of becoming true. `liveTick` re-checks on the way back to the app, for
  // the reader who returns before the tick lands.
  // Booleans and numbers in the dependency list only: fetchTrackerStatus
  // resolves a fresh object each time, and depending on `status` would rebuild
  // this effect on every response and re-fire its immediate load.
  // The pause keys ride along with this poll rather than getting a timer of
  // their own. A minute's lag is right for a notice — the tray flipped it, so
  // the reader already knows — and `liveTick` re-reads on the way back to the
  // app, which is when someone who paused elsewhere actually looks.
  useEffect(() => {
    if (!ready) return;
    const load = () => {
      void fetchTrackerStatus().then(setStatus).catch(() => {});
      void fetchSettings()
        .then((s) => setTrayPause({
          tracking_paused: s.tracking_paused ?? "0",
          tracking_paused_until: s.tracking_paused_until ?? "0",
        }))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [ready, liveTick]);

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

  const openSettings = () => setTab("settings");
  const handlePreset = (next: PresetOrCustom) => {
    if (
      next !== preset
      && next !== "custom"
      && next !== "alltime"
      && firstSessionSec !== null
    ) {
      const requested = !rolling && isRollingPreset(next)
        ? rangeForCalendarPreset(next, meta.weekStart)
        : rangeForPreset(next);
      const effective = clampRangeStart(requested, firstSessionSec);
      if (effective.start > requested.start && rangesEqual(effective, range)) {
        const labels: Record<Exclude<PresetOrCustom, "custom" | "alltime">, string> = {
          today: "Today",
          last7: "Week",
          last14: "Two weeks",
          last30: "Month",
          last90: "Quarter",
          last365: "Year",
        };
        banner.show(
          `Only ${calendarDays(effective)} days recorded, so ${labels[next]} currently shows all available history.`,
        );
      }
    }
    setPreset(next);
  };
  const handleStarted = (needsStartup: boolean | null) => {
    if (needsStartup === null) return;
    setStartPending(true);
    setOfferStartup(needsStartup);
  };

  // Switching on the state rather than the plan's id keeps the union narrowed,
  // so a banner cannot be handed data belonging to a different state. Visibility
  // is already settled by `trackerBannerVisible`.
  const renderTrackerBanner = () => {
    if (!trackerBannerVisible || trackerState === null) return null;
    switch (trackerState.kind) {
      case "recording":
        return (
          <WelcomePanel
            offerStartup={offerStartup}
            onDeclineStartup={() => setOfferStartup(false)}
          />
        );
      case "never_started":
      case "starting":
        return (
          <StartRecordingPanel
            live={false}
            onRefreshStatus={refreshTrackerStatus}
            onOpenSettings={openSettings}
            onStarted={handleStarted}
          />
        );
      case "consent_withdrawn":
        return (
          <RecordingOffPanel
            onRefreshStatus={refreshTrackerStatus}
            onOpenSettings={openSettings}
            onStarted={handleStarted}
          />
        );
      case "paused":
        return (
          <PauseNotice
            until={trackerState.until}
            live={heartbeatAgeSec !== null && heartbeatAgeSec < TRACKER_ALERT_STALE_SECONDS}
            onDismiss={() => setPauseNoticeDismissed(true)}
            onResumed={() =>
              setTrayPause({ tracking_paused: "0", tracking_paused_until: "0" })}
          />
        );
      case "off_schedule":
        return (
          <OffScheduleNotice
            nextStart={trackerState.nextStart}
            valid={trackerState.valid}
            onOpenSettings={openSettings}
          />
        );
      case "stopped":
        return <TrackerAlert onOpenSettings={openSettings} />;
      case "unconfirmed":
        // Unreachable: bannerFor gives this state no plan, so
        // `trackerBannerVisible` above is already false. Spelled out anyway so
        // the union stays exhaustive and a future banner for it has to be a
        // decision someone makes here rather than a fallthrough.
        return null;
    }
  };

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
            onPreset={handlePreset}
            onRollingChange={setRolling}
            onCustomRange={(r) => {
              setCustomRange(clampCustomRange(r, firstSessionSec));
              setPreset("custom");
            }}
            firstSessionSec={firstSessionSec}
          />
        )}
      </header>

      {/* At most one, and never on Settings, whose own status panel says the
          same thing with an animated dot and its own start button.
          Which tabs each one reaches is the plan's `scope`. The teaching panels
          are Insights-only: they persist until dismissed, and at the 500x480
          minimum a tall panel drove the Activity table's first row out of a
          region that scrolls internally, leaving it unreachable. Insights is
          also where they belong, since their own advice is to go look at
          Activity. The short ones — a stopped tracker, a pause — reach every
          tab, because a reader who is not on Insights is no less affected, and
          they leave the table its room. */}
      {renderTrackerBanner()}

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
          className="pointer-events-none absolute top-1 bottom-1 rounded-lg bg-selected transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
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
