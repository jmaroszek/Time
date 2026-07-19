import { useEffect, useMemo, useState } from "react";

import DateRangePicker, { type PresetOrCustom } from "./components/DateRangePicker";
import { Spinner } from "./components/ui";
import { getDbPath } from "./lib/db";
import { isMissingSchemaError } from "./lib/dbErrors";
import { fetchTrackerStatus, type TrackerStatus } from "./lib/queries";
import { isNewerSchemaError } from "./lib/schema";
import { rangeForPreset, type Range } from "./lib/time";
import { BannerProvider } from "./state/banner";
import { MetaProvider, useMeta } from "./state/meta";
import AppsTab from "./tabs/AppsTab";
import OverviewTab from "./tabs/OverviewTab";
import SettingsTab from "./tabs/SettingsTab";
import TrendsTab from "./tabs/TrendsTab";

type Tab = "overview" | "trends" | "apps" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "trends", label: "Trends" },
  { id: "apps", label: "Apps" },
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
  const [tab, setTab] = useState<Tab>("overview");
  const [preset, setPreset] = useState<PresetOrCustom>("last7");
  const [customRange, setCustomRange] = useState<Range | null>(null);
  const [status, setStatus] = useState<TrackerStatus | null>(null);

  const range = useMemo<Range>(() => {
    if (preset === "custom" && customRange) return customRange;
    return rangeForPreset(preset === "custom" ? "last7" : preset);
  }, [preset, customRange]);

  // REL-001: an empty DB (tracker hasn't run yet) is a waiting state, not an
  // error. Retry until the tracker's first bootstrap creates the schema.
  const waitingForTracker = meta.loaded && meta.error !== null && isMissingSchemaError(meta.error);
  useEffect(() => {
    if (!waitingForTracker) return;
    const id = setInterval(() => void meta.refresh(), 5000);
    return () => clearInterval(id);
  }, [waitingForTracker, meta.refresh]);

  // First-run panel data: poll tracker status only until the first session exists.
  const ready = meta.loaded && meta.error === null;
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

  const showRange = tab === "overview" || tab === "apps";

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
            onPreset={setPreset}
            onCustomRange={(r) => {
              setCustomRange(r);
              setPreset("custom");
            }}
          />
        )}
      </header>

      {firstRun && <FirstRunPanel status={status} />}

      <main className="flex-1">
        {tab === "overview" && <OverviewTab range={range} preset={preset} />}
        {tab === "trends" && <TrendsTab />}
        {tab === "apps" && <AppsTab range={range} />}
        {tab === "settings" && <SettingsTab />}
      </main>
    </div>
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
        Time records which app is in the foreground, its window title, and — for browsers — the
        site&apos;s domain. Everything stays in a database file on this machine. Nothing is ever
        uploaded.
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
        To split browser time by site, install the &quot;URL in title&quot; browser extension
        (third-party — it&apos;s what Time is tested with); without it, browser time is tracked
        per app only. As data arrives, assign categories on the Apps tab — rules re-classify
        all history instantly.
      </p>
    </section>
  );
}

/** REL-001 waiting state: the DB file exists but has no schema yet, which
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

/** REL-004: refuse read/write work when an older dashboard sees a newer DB. */
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

/** UX-001: user-facing copy for a genuinely broken DB connection. The raw
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
          {error} — check VITE_DB_PATH / src/lib/db.ts (dev-only hint).
        </p>
      )}
    </div>
  );
}
