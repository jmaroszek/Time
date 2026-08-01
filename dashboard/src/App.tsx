import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import DateRangePicker, { type PresetOrCustom } from "./components/DateRangePicker";
import { Button, Checkbox, Spinner } from "./components/ui";
import { getDbPath } from "./lib/db";
import { isMissingSchemaError } from "./lib/dbErrors";
import {
  currentHistoryRevision,
  invalidateHistory,
  subscribeHistoryInvalidation,
} from "./lib/historyInvalidation";
import { deleteCategory, fetchEarliestSessionStart, fetchTrackerStatus, takeRestoreNotice, updateSetting, type TrackerStatus } from "./lib/queries";
import { isNewerSchemaError } from "./lib/schema";
import { allTimeRange, isRollingPreset, rangeForCalendarPreset, rangeForPreset, type Range } from "./lib/time";
import {
  BACKLOG_BADGE_SECONDS,
  backlogOnlyQuery,
  type ActivitySource,
} from "./lib/activity";
import { BannerProvider, useBanner } from "./state/banner";
import { MetaProvider, useMeta } from "./state/meta";
import { useActivityModel } from "./state/useActivityModel";
import { useInsightsView } from "./state/useInsightsView";
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

/** How long the welcome panel waits for a heartbeat before admitting it cannot
 *  tell whether the tracker came up. Comfortably past the status poll's ten
 *  seconds, so a slow first heartbeat is not reported as a failure. */
const TRACKER_CONFIRM_MS = 25_000;

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

  useEffect(() => {
    void takeRestoreNotice()
      .then((notice) => {
        if (!notice) return;
        if (notice.ok) banner.show(notice.message);
        else banner.report(new Error(notice.message));
      })
      .catch(() => {});
  }, [banner]);

  const range = useMemo<Range>(() => {
    if (preset === "custom") return customRange ?? rangeForPreset("last7");
    if (preset === "alltime") return allTimeRange(firstSessionSec);
    if (!rolling && isRollingPreset(preset)) return rangeForCalendarPreset(preset, meta.weekStart);
    return rangeForPreset(preset);
  }, [preset, rolling, customRange, firstSessionSec, meta.weekStart]);

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
  const firstRun = status !== null && status.totalSessionCount === 0;
  // Depend on the answer, not on `status` itself. fetchTrackerStatus resolves a
  // new object every time, so keeping `status` in the dependency list tore this
  // effect down and rebuilt it on every poll — and because the body starts with
  // an immediate load(), each rebuild issued another query at once. On a
  // database with no sessions the guard below never fires, so that ran as an
  // unbounded loop: roughly twelve hundred queries a second, for as long as a
  // fresh install went without its first session.
  const awaitingFirstSession = status === null || status.totalSessionCount === 0;
  useEffect(() => {
    if (!ready || !awaitingFirstSession) return;
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
  }, [ready, awaitingFirstSession]);

  // The backlog behind the Activity tab's mark. It lives here rather than in
  // ActivityTab because the reader who most needs telling is the one who has
  // never opened that tab — and an unmounted tab cannot report anything. The
  // window is the same all-time one ActivityTab asks for, so the session cache
  // serves both from one fetch, and the worker reuses its index across them.
  const backlogRange = useMemo(
    () => allTimeRange(firstSessionSec),
    [firstSessionSec, historyRevision],
  );
  const backlogSessions = useSessions(
    backlogRange.start.getTime() / 1000,
    backlogRange.end.getTime() / 1000,
    historyRevision,
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
        <TabBar tab={tab} onTab={setTab} backlog={showBacklogBadge} />
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

      {firstRun && (
        <FirstRunPanel
          status={status}
          onRefreshStatus={refreshTrackerStatus}
          onOpenSettings={() => setTab("settings")}
        />
      )}

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
            onOpenSettings={() => {
              setHighlightSection("Goals");
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

function PrivacyOnboarding() {
  const meta = useMeta();
  const [windowTitles, setWindowTitles] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(true);
  const [startWithEssentials, setStartWithEssentials] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = async (enable: boolean) => {
    setSaving(true);
    setError(null);
    try {
      if (meta.settings.starter_categories_pending === "1") {
        if (!startWithEssentials) {
          // Exactly what _SEED_CATEGORIES inserts, minus the functional Ignored
          // row the app keeps either way. A name left out here survives as an
          // orphan the reader never asked for.
          const starterNames = new Set([
            "Work",
            "Communication",
            "Browsing",
            "Entertainment",
            "System",
          ]);
          for (const category of meta.categories) {
            if (starterNames.has(category.name)) await deleteCategory(category.id);
          }
        }
        await updateSetting("starter_categories_pending", "0");
      }
      await updateSetting("record_window_titles", enable && windowTitles ? "1" : "0");
      await updateSetting("launch_at_login", enable && startAtLogin ? "1" : "0");
      await updateSetting("recording_consent", enable ? "1" : "0");
      await invoke("set_launch_at_login", { enabled: enable && startAtLogin });
      if (enable) await invoke("start_tracker");
      await updateSetting("privacy_onboarding_complete", "1");
      await meta.refresh();
    } catch (cause) {
      // Do not leave a partially completed first-run flow recording activity.
      await updateSetting("recording_consent", "0").catch(() => {});
      await updateSetting("launch_at_login", "0").catch(() => {});
      await invoke("set_launch_at_login", { enabled: false }).catch(() => {});
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-3 sm:p-8">
      <section className="scroll-well max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-[18px] border border-edge bg-surface px-4 py-5 shadow-panel sm:max-h-[calc(100dvh-4rem)] sm:px-7 sm:py-6">
        <p className="text-micro font-bold uppercase tracking-[.12em] text-accent">Private by design</p>
        <h1 className="mt-2 text-lg font-semibold text-ink">Choose what Time can record</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
          Time has no accounts, servers, or telemetry. All activity is recorded and analyzed
          locally. Your data stays yours forever.
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div className="rounded-xl border border-edge bg-surface-dim p-4">
            <p className="font-medium">When tracking is enabled</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
              Time tracks which apps you use and for how long. In your browser, it can also track
              the websites you visit, but not the specific pages.
            </p>
          </div>
          {/* Ordered by default state, not importance: the two boxes that ship
              checked come first, so the one setting a reader has to opt into is
              also the last thing they pass on the way to the button. */}
          <ConsentCheck
            checked={startAtLogin}
            onChange={setStartAtLogin}
            title="Start the tracker when I sign in"
            detail="Runs only for this Windows account. You can disable tracking and startup later in Settings."
          />
          {meta.settings.starter_categories_pending === "1" && (
            <ConsentCheck
              checked={startWithEssentials}
              onChange={setStartWithEssentials}
              title="Start with essential categories"
              detail="Adds Work, Communication, Browsing, Entertainment, and System without classifying any apps or sites. You can rename, change, or delete them later."
            />
          )}
          <ConsentCheck
            checked={windowTitles}
            onChange={setWindowTitles}
            title="Store window titles"
            detail="Storing window titles lets you create rules that separate work from leisure within the same app. Titles may include document names, email subjects, or other sensitive text, so this setting is off by default."
          />
        </div>

        {error && <p className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => void complete(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving…" : "Start tracking"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void complete(false)}
            className="rounded-lg border border-edge-2 px-4 py-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Not now
          </button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          Choosing “Not now” opens the dashboard without starting or registering the tracker.
        </p>
      </section>
    </div>
  );
}

function ConsentCheck({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  detail: string;
}) {
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      size="md"
      align="start"
      className="gap-3 rounded-xl border border-edge bg-surface-dim p-4"
    >
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-3">{detail}</span>
      </span>
    </Checkbox>
  );
}

/** Shown while this database has zero sessions, and only until the first one
 *  lands. It deliberately does not restate what Time records or repeat the
 *  browser-extension caveat: the consent screen has just said the first, and
 *  the second now has two better-targeted homes — the Activity hint, which
 *  fires when browser time actually goes unsplit, and the Settings row. This
 *  panel answers one question, which is whether anything is being recorded
 *  right now. */
function FirstRunPanel({
  status,
  onRefreshStatus,
  onOpenSettings,
}: {
  status: TrackerStatus;
  onRefreshStatus: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [starting, setStarting] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [offerStartup, setOfferStartup] = useState(false);
  const [startAttempted, setStartAttempted] = useState(false);
  const [startUnconfirmed, setStartUnconfirmed] = useState(false);
  const heartbeatAge = status.lastHeartbeat == null ? null : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < 120;

  // Consent first, then launch: a tracker started while recording_consent is
  // "0" comes up and records nothing, which would read here as a button that
  // did nothing at all. Startup-at-login is deliberately not bundled in — it
  // writes a registry entry, and this button asks for tracking, not for a
  // permanent change to the machine. It is offered separately below, because
  // tracking that silently stops at the next shutdown is a worse surprise than
  // being asked.
  const startTracking = async () => {
    // Read before the refresh: `meta` is this render's snapshot, so asking it
    // after meta.refresh() would answer from the pre-refresh value anyway.
    const needsStartup = meta.settings.launch_at_login !== "1";
    setStarting(true);
    try {
      await updateSetting("recording_consent", "1");
      await invoke("start_tracker");
      await Promise.all([meta.refresh(), onRefreshStatus()]);
      setStartAttempted(true);
      if (needsStartup) setOfferStartup(true);
    } catch (cause) {
      banner.report(cause, "tracker startup");
    } finally {
      setStarting(false);
    }
  };

  // start_tracker resolves as soon as the process is spawned, not once it is
  // recording — a tracker that dies immediately (a stale instance already
  // holding the mutex, a failed launch) reports success and then changes
  // nothing on screen. Give it a window to prove itself by writing a heartbeat,
  // and say so plainly if it never does, rather than leaving a button that
  // looks like it did nothing.
  useEffect(() => {
    if (!startAttempted) return;
    if (trackerLive) {
      setStartUnconfirmed(false);
      setStartAttempted(false);
      return;
    }
    const id = setTimeout(() => setStartUnconfirmed(true), TRACKER_CONFIRM_MS);
    return () => clearTimeout(id);
  }, [startAttempted, trackerLive]);

  const enableStartup = async () => {
    setRegistering(true);
    try {
      await updateSetting("launch_at_login", "1");
      await invoke("set_launch_at_login", { enabled: true });
      await meta.refresh();
      setOfferStartup(false);
    } catch (cause) {
      banner.report(cause, "startup registration");
    } finally {
      setRegistering(false);
    }
  };

  return (
    <section className="rounded-[14px] border border-accent/25 bg-gradient-to-b from-accent/[.06] to-accent/[.02] px-5 py-4 text-xs leading-relaxed">
      <p className="text-row font-semibold">Welcome to Time</p>
      {trackerLive ? (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-ink-2">
            <span className="h-2 w-2 rounded-full bg-good-data" />
            Tracking is on. Your first activity will appear here within a minute.
          </p>
          {offerStartup && (
            <div className="mt-3 rounded-[10px] border border-edge bg-surface-2/60 px-3 py-2.5">
              <p className="text-ink-2">
                Time won&rsquo;t come back on its own after you shut down. Start it automatically
                when you sign in?
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={registering}
                  onClick={() => void enableStartup()}
                >
                  {registering ? "Saving…" : "Start at sign-in"}
                </Button>
                <Button onClick={() => setOfferStartup(false)}>Not now</Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-ink-2">
            <span className="h-2 w-2 rounded-full bg-bad" />
            The tracker isn&rsquo;t running, so nothing is being recorded.
          </p>
          <p className="mt-1 text-ink-2">
            Start tracking when you&rsquo;re ready, or review your settings first.
          </p>
          {startUnconfirmed && (
            <p className="mt-2 text-bad">
              Time couldn&rsquo;t confirm the tracker started. Open Settings to check its status.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={starting} onClick={() => void startTracking()}>
              {starting ? "Starting…" : "Start tracking"}
            </Button>
            <Button onClick={onOpenSettings}>Open settings</Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Waiting state: the DB file exists but has no schema yet, which
 *  means the tracker has never run. Auto-refreshes via the Shell effect. */
function WaitingForTracker() {
  return (
    <div className="flex h-full min-h-80 items-center justify-center p-10">
      <div className="max-w-md text-sm">
        <p className="font-semibold">Waiting for the tracker&apos;s first data</p>
        <p className="mt-2 text-ink-2">
          Time&apos;s tracker creates the database the first time it runs. Start the tracker and
          this screen will update by itself within a few seconds.
        </p>
        <p className="mt-4 break-all font-mono text-xs text-ink-3">{getDbPath()}</p>
      </div>
    </div>
  );
}

/** Refuse read/write work when an older dashboard sees a newer DB. */
function NewerDatabaseScreen() {
  return (
    <div className="p-10 text-sm">
      <p className="font-semibold">This database needs a newer version of Time</p>
      <p className="mt-2 max-w-md text-ink-2">
        Your data was created by a newer Time release than this dashboard supports. Update Time
        and open it again. This version has not changed the database.
      </p>
      <p className="mt-3 break-all font-mono text-xs text-ink-3">{getDbPath()}</p>
    </div>
  );
}

/** User-facing copy for a genuinely broken DB connection. The raw
 *  error is one click away instead of front and center. */
function DbErrorScreen({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="p-10 text-sm">
      <p className="font-semibold text-bad">Time couldn&apos;t read its database</p>
      <p className="mt-2 max-w-md text-ink-2">
        If you just installed, make sure the tracker has started — it creates the database on
        first run. Otherwise the file below may be locked or unreadable.
      </p>
      <p className="mt-3 break-all font-mono text-xs text-ink-3">{getDbPath()}</p>
      <button
        type="button"
        className="mt-4 rounded-lg border border-edge-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
        onClick={() =>
          void navigator.clipboard.writeText(error).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy error details"}
      </button>
      {import.meta.env.DEV && (
        <p className="mt-4 max-w-xl break-all text-xs text-ink-3">
          {error} — check TIME_DB_PATH / src/lib/db.ts (debug-only hint).
        </p>
      )}
    </div>
  );
}
