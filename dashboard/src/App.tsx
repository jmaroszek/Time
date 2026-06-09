import { useMemo, useState } from "react";

import DateRangePicker, { type PresetOrCustom } from "./components/DateRangePicker";
import { Spinner } from "./components/ui";
import { rangeForPreset, type Range } from "./lib/time";
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
      <Shell />
    </MetaProvider>
  );
}

function Shell() {
  const meta = useMeta();
  const [tab, setTab] = useState<Tab>("overview");
  const [preset, setPreset] = useState<PresetOrCustom>("last7");
  const [customRange, setCustomRange] = useState<Range | null>(null);

  const range = useMemo<Range>(() => {
    if (preset === "custom" && customRange) return customRange;
    return rangeForPreset(preset === "custom" ? "last7" : preset);
  }, [preset, customRange]);

  if (!meta.loaded) return <Spinner label="Connecting to database..." />;
  if (meta.error) {
    return (
      <div className="p-10 text-sm">
        <p className="font-semibold text-bad">Could not open the database</p>
        <p className="mt-2 break-all text-ink-2">{meta.error}</p>
        <p className="mt-4 text-ink-3">
          Check VITE_DB_PATH / dashboard src/lib/db.ts and that the DB file exists.
        </p>
      </div>
    );
  }

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

      <main className="flex-1">
        {tab === "overview" && <OverviewTab range={range} />}
        {tab === "trends" && <TrendsTab />}
        {tab === "apps" && <AppsTab range={range} />}
        {tab === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}
