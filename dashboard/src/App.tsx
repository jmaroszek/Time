import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import DateRangePicker, { type PresetOrCustom } from "./components/DateRangePicker";
import { Spinner } from "./components/ui";
import { getDbPath } from "./lib/db";
import { isMissingSchemaError } from "./lib/dbErrors";
import { currentHistoryRevision, subscribeHistoryInvalidation } from "./lib/historyInvalidation";
import { deleteCategory, fetchEarliestSessionStart, fetchTrackerStatus, updateSetting, type TrackerStatus } from "./lib/queries";
import { isNewerSchemaError } from "./lib/schema";
import { allTimeRange, isRollingPreset, rangeForCalendarPreset, rangeForPreset, type Range } from "./lib/time";
import { BannerProvider } from "./state/banner";
import { MetaProvider, useMeta } from "./state/meta";
import ActivityTab from "./tabs/ActivityTab";
import OverviewTab from "./tabs/OverviewTab";
import SettingsTab from "./tabs/SettingsTab";

type Tab = "insights" | "activity" | "settings";

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
  const [tab, setTab] = useState<Tab>("insights");
  const [preset, setPreset] = useState<PresetOrCustom>("last7");
  const [rolling, setRolling] = useState(true);
  const [customRange, setCustomRange] = useState<Range | null>(null);
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [firstSessionSec, setFirstSessionSec] = useState<number | null>(null);
  const [historyRevision, setHistoryRevision] = useState(currentHistoryRevision);

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
  useEffect(() => {
    if (!ready || (status !== null && status.totalSessionCount > 0)) return;
    let cancelled = false;
    const load = () =>
      void fetchTrackerStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready, status]);

  if (!meta.loaded) return <Spinner label="Connecting to database..." />;
  if (waitingForTracker) return <WaitingForTracker />;
  if (meta.error && isNewerSchemaError(meta.error)) return <NewerDatabaseScreen />;
  if (meta.error) return <DbErrorScreen error={meta.error} />;
  if (meta.settings.privacy_onboarding_complete !== "1") return <PrivacyOnboarding />;

  const showRange = tab === "insights" || tab === "activity";

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-4 px-6 py-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-edge bg-surface p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
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

      {firstRun && <FirstRunPanel status={status} />}

      <main className="flex-1">
        {tab === "insights" && (
          <OverviewTab range={range} preset={preset} firstSessionSec={firstSessionSec} />
        )}
        {tab === "activity" && (
          <ActivityTab
            range={range}
            firstSessionSec={firstSessionSec}
            historyRevision={historyRevision}
            isAllTime={preset === "alltime"}
            onTryAllTime={() => setPreset("alltime")}
          />
        )}
        {tab === "settings" && <SettingsTab />}
      </main>
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
          const starterNames = new Set([
            "Focus",
            "Learning",
            "Communication",
            "Entertainment",
            "Utilities",
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
    <div className="flex min-h-full items-center justify-center p-8">
      <section className="w-full max-w-2xl rounded-[18px] border border-edge bg-surface px-7 py-6 shadow-2xl shadow-black/20">
        <p className="text-[11px] font-bold uppercase tracking-[.12em] text-accent">Private by design</p>
        <h1 className="mt-2 text-xl font-semibold text-ink">Choose what Time may record</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
          Time has no account, server, analytics, or telemetry. Activity is written only to your
          per-user SQLite database. Nothing is uploaded.
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div className="rounded-xl border border-edge bg-surface-dim p-4">
            <p className="font-medium">When tracking is enabled</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
              Time stores the foreground app name, start and end time, and idle or lock periods.
              Browser domains are derived in memory when an optional URL-in-title extension is
              present; URL paths, queries, fragments, and credentials are never stored.
            </p>
          </div>
          {meta.settings.starter_categories_pending === "1" && (
            <ConsentCheck
              checked={startWithEssentials}
              onChange={setStartWithEssentials}
              title="Start with essential categories"
              detail="Adds Focus, Learning, Communication, Entertainment, and Utilities without classifying any apps or sites. You can rename, change, or delete them later."
            />
          )}
          <ConsentCheck
            checked={windowTitles}
            onChange={setWindowTitles}
            title="Also store sanitized window titles"
            detail="Off by default. Titles can reveal document names, email subjects, or other sensitive text. Browser URLs are stripped even when this is enabled."
          />
          <ConsentCheck
            checked={startAtLogin}
            onChange={setStartAtLogin}
            title="Start the tracker when I sign in"
            detail="Runs only for this Windows account. You can disable tracking or startup later in Settings."
          />
        </div>

        {error && <p className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => void complete(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-[#081019] transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving…" : "Enable private tracking"}
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
        <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
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
    <label className="flex cursor-pointer gap-3 rounded-xl border border-edge bg-surface-dim p-4">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
      />
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-3">{detail}</span>
      </span>
    </label>
  );
}

/** Shown while this database has zero sessions: says what is recorded, that it
 *  stays local, whether the tracker is live, and the browser-extension caveat.
 *  Disappears on its own once the first session lands. */
function FirstRunPanel({ status }: { status: TrackerStatus }) {
  const heartbeatAge = status.lastHeartbeat == null ? null : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < 120;
  return (
    <section className="rounded-[14px] border border-accent/25 bg-[linear-gradient(180deg,rgba(107,160,218,.06),rgba(107,160,218,.02))] px-5 py-4 text-xs leading-relaxed">
      <p className="text-[13px] font-semibold">Welcome to Time</p>
      <p className="mt-2 text-ink-2">
        Time records foreground apps and timing. Window titles are stored only if you opted in;
        browser URLs are stripped before anything reaches the database. Everything stays in a
        local file and nothing is uploaded.
      </p>
      <p className="mt-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${trackerLive ? "bg-good-data" : "bg-bad"}`} />
        {trackerLive ? (
          <span className="text-ink-2">
            The tracker is running — your first activity will appear here within a minute.
          </span>
        ) : (
          <span className="text-ink-2">
            The tracker isn&apos;t running yet — nothing is recorded until it starts. Its status
            also lives in Settings.
          </span>
        )}
      </p>
      <p className="mt-2 text-ink-2">
        Site splitting is optional and requires a third-party extension that adds the current URL
        to the browser title. Such extensions can see browsing data, so review their permissions
        before installing one. Without an extension, browser time is tracked per app only.
      </p>
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
        <p className="mt-4 break-all font-mono text-[11px] text-ink-3">{getDbPath()}</p>
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
      <p className="mt-3 break-all font-mono text-[11px] text-ink-3">{getDbPath()}</p>
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
      <p className="mt-3 break-all font-mono text-[11px] text-ink-3">{getDbPath()}</p>
      <button
        type="button"
        className="mt-4 rounded-lg border border-edge-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-white/[.035] hover:text-ink"
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
        <p className="mt-4 max-w-xl break-all text-[11px] text-ink-3">
          {error} — check TIME_DB_PATH / src/lib/db.ts (debug-only hint).
        </p>
      )}
    </div>
  );
}
