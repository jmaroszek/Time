import { useEffect, useState, type ReactNode } from "react";

import { Button, Card, Spinner } from "../components/ui";
import { getDbPath } from "../lib/db";
import { fmtDuration } from "../lib/format";
import { backupDatabase, fetchTrackerStatus, updateSetting, type TrackerStatus } from "../lib/queries";
import { useMeta } from "../state/meta";

interface NumericSpec {
  key: string;
  min: number;
  max: number;
  scale: number;
  step?: number;
}

const SPECS = {
  goal: { key: "weekly_goal_hours", min: 1, max: 100, scale: 1 },
  minimum: { key: "min_app_seconds", min: 0, max: 30, scale: 60 },
  start: { key: "day_start_hour", min: 0, max: 23, scale: 1 },
  end: { key: "day_end_hour", min: 1, max: 24, scale: 1 },
  idle: { key: "idle_threshold_seconds", min: 1, max: 60, scale: 60 },
  focus: { key: "focus_chain_max_gap_seconds", min: 0, max: 30, scale: 60 },
  heartbeat: { key: "heartbeat_seconds", min: 5, max: 300, scale: 1, step: 5 },
} satisfies Record<string, NumericSpec>;

function displayValue(spec: NumericSpec, raw: string | undefined): string {
  const value = Number(raw);
  return Number.isFinite(value) ? String(Math.round((value / spec.scale) * 100) / 100) : "";
}

function clockHour(value: number): string {
  const normalized = value % 24;
  return `${normalized % 12 || 12} ${normalized < 12 ? "AM" : "PM"}`;
}

export default function SettingsTab() {
  const meta = useMeta();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);

  useEffect(() => {
    const next = { ...meta.settings };
    for (const spec of Object.values(SPECS)) next[spec.key] = displayValue(spec, meta.settings[spec.key]);
    setDrafts(next);
  }, [meta.settings]);

  useEffect(() => {
    const load = () => void fetchTrackerStatus().then(setStatus).catch(() => setStatus(null));
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!meta.loaded) return <Spinner />;

  const saveNumeric = async (spec: NumericSpec, requested?: number) => {
    const raw = requested ?? Number(drafts[spec.key]);
    const fallback = Number(displayValue(spec, meta.settings[spec.key]));
    const valid = Number.isFinite(raw) ? raw : fallback;
    const clamped = Math.min(Math.max(valid, spec.min), spec.max);
    setDrafts((current) => ({ ...current, [spec.key]: String(clamped) }));
    await updateSetting(spec.key, String(Math.round(clamped * spec.scale)));
    await meta.refresh();
  };
  const step = (spec: NumericSpec, direction: -1 | 1) => {
    const current = Number(drafts[spec.key]);
    const fallback = Number(displayValue(spec, meta.settings[spec.key])) || spec.min;
    void saveNumeric(spec, (Number.isFinite(current) ? current : fallback) + direction * (spec.step ?? 1));
  };
  const saveText = async (key: string) => {
    const value = (drafts[key] ?? "").trim();
    if (!value) {
      setDrafts((current) => ({ ...current, [key]: meta.settings[key] ?? "" }));
      return;
    }
    await updateSetting(key, value);
    await meta.refresh();
  };
  const selectSetting = (key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
    void updateSetting(key, value).then(meta.refresh);
  };

  const heartbeatAge = status?.lastHeartbeat == null ? null : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < 120;

  const numberControl = (spec: NumericSpec, unit?: string, hour = false) => (
    <NumberStepper
      value={drafts[spec.key] ?? ""}
      display={hour ? clockHour(Number(drafts[spec.key]) || 0) : undefined}
      unit={unit}
      readOnly={hour}
      onChange={(value) => setDrafts((current) => ({ ...current, [spec.key]: value }))}
      onBlur={() => void saveNumeric(spec)}
      onMinus={() => step(spec, -1)}
      onPlus={() => step(spec, 1)}
    />
  );

  return (
    <div className="grid grid-cols-2 items-start gap-4">
      <div className="flex flex-col gap-3.5">
        <SettingsGroup title="Goals">
          <SettingRow label="Weekly productive goal" help="Target the goal-pace card measures against." control={numberControl(SPECS.goal, "h")} />
        </SettingsGroup>

        <SettingsGroup title="App lists">
          <SettingRow
            label="Default top apps shown"
            help="Initial size of the Overview top-apps list."
            control={<Segmented options={["5", "10", "15", "20"]} value={drafts.default_top_n_apps ?? "5"} onChange={(value) => selectSetting("default_top_n_apps", value)} />}
          />
          <SettingRow label="Minimum app time" help="Apps below this in the range are hidden from the lists. 0 shows everything." control={numberControl(SPECS.minimum, "min")} />
        </SettingsGroup>

        <SettingsGroup title="Timeline window">
          <SettingRow label="Day starts at" help="First hour shown on Timeline & Hour-of-Day plots." control={numberControl(SPECS.start, undefined, true)} />
          <SettingRow label="Day ends at" help="Last hour shown on Timeline & Hour-of-Day plots." control={numberControl(SPECS.end, undefined, true)} />
          <SettingRow
            label="Week starts on"
            help="Affects weekly presets, trends, and goal pacing."
            control={<Segmented options={["Sunday", "Monday"]} value={drafts.week_start ?? "Sunday"} onChange={(value) => selectSetting("week_start", value)} />}
          />
        </SettingsGroup>
      </div>

      <div className="flex flex-col gap-3.5">
        <Card title="Tracker & Database">
          <div className="flex items-center gap-2 text-xs">
            <span className={`h-2 w-2 rounded-full ${trackerLive ? "live-pulse bg-[#16b981]" : "bg-bad"}`} />
            <span className="font-medium">{trackerLive ? "Tracker is live" : "Tracker not detected"}</span>
            {heartbeatAge !== null && <span className="ml-auto text-[11px] text-ink-3">last heartbeat {fmtDuration(Math.max(heartbeatAge, 0))} ago</span>}
          </div>

          <div className="mt-5">
            <p className="mb-2 text-[11px] text-ink-3">Database</p>
            <div className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 p-2 pl-3">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2" title={getDbPath()}>{getDbPath()}</span>
              <button
                type="button"
                className="rounded-md border border-edge px-2 py-1 text-[10.5px] text-ink-3 transition-colors hover:border-edge-2 hover:text-ink-2"
                onClick={() => {
                  void navigator.clipboard.writeText(getDbPath()).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="mt-4 border-t border-edge/60 pt-4">
            <Button
              variant="primary"
              onClick={() => {
                setBackupMessage(null);
                void backupDatabase()
                  .then(() => {
                    setBackupMessage("✓ Backup written");
                    setTimeout(() => setBackupMessage(null), 2000);
                  })
                  .catch(() => setBackupMessage("Backup failed"));
              }}
            >
              {backupMessage ?? "Back up database now"}
            </Button>
            <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
              Settings save on change and the tracker picks them up within one heartbeat — no restart needed.
            </p>
          </div>
        </Card>

        <div className="rounded-[14px] border border-edge bg-surface">
          <button type="button" className="flex w-full items-center gap-2 px-5 py-4 text-left" onClick={() => setAdvancedOpen((open) => !open)}>
            <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-2">Tracking engine</span>
            <span className="text-[10.5px] text-ink-3">advanced</span>
            <span className={`ml-auto text-[10px] text-ink-3 transition-transform duration-200 ${advancedOpen ? "rotate-90" : ""}`}>▶</span>
          </button>
          {advancedOpen && (
            <div className="border-t border-edge/50 px-5 pb-2 pt-1">
              <SettingRow label="AFK idle threshold" help="No input for this long marks you AFK." control={numberControl(SPECS.idle, "min")} />
              <SettingRow label="Focus streak max gap" help="Short gaps won't break a productive streak." control={numberControl(SPECS.focus, "min")} />
              <SettingRow label="Heartbeat interval" help="How often the active session is flushed." control={numberControl(SPECS.heartbeat, "s")} />
              <SettingRow
                label="Browser processes"
                help="Comma-separated; enables domain and title matching."
                control={
                  <input
                    value={drafts.browser_processes ?? ""}
                    onChange={(event) => setDrafts((current) => ({ ...current, browser_processes: event.target.value }))}
                    onBlur={() => void saveText("browser_processes")}
                    onKeyDown={(event) => { if (event.key === "Enter") void saveText("browser_processes"); }}
                    className="w-48 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent/60"
                  />
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-edge bg-surface px-5 py-4">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-2">{title}</span>
        <span className="h-px flex-1 bg-edge" />
      </div>
      {children}
    </div>
  );
}

function SettingRow({ label, help, control }: { label: string; help: string; control: ReactNode }) {
  return (
    <div className="flex min-h-[64px] items-center justify-between gap-4 border-b border-edge/40 py-3 last:border-0 last:pb-1">
      <div className="min-w-0">
        <p className="text-xs text-ink">{label}</p>
        <p className="mt-1 max-w-64 text-[11px] leading-snug text-ink-3">{help}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function NumberStepper({
  value,
  display,
  unit,
  readOnly = false,
  onChange,
  onBlur,
  onMinus,
  onPlus,
}: {
  value: string;
  display?: string;
  unit?: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <div className="flex items-center rounded-[9px] border border-edge bg-surface-2 p-[3px] transition-colors hover:border-edge-2">
      <button type="button" className="h-6 w-7 rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={onMinus}>−</button>
      <input
        type={readOnly ? "text" : "number"}
        readOnly={readOnly}
        value={display ?? value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        className={`${readOnly ? "w-[58px]" : "w-12"} bg-transparent text-center text-xs font-semibold tabular-nums outline-none`}
      />
      {unit && <span className="mr-1 text-[10.5px] text-ink-3">{unit}</span>}
      <button type="button" className="h-6 w-7 rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={onPlus}>+</button>
    </div>
  );
}

function Segmented({ options, value, onChange }: { options: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex rounded-[9px] border border-edge bg-surface-2 p-0.5">
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={`rounded-[7px] px-3 py-1.5 text-[10.5px] transition-colors ${value === option ? "bg-accent/15 text-accent" : "text-ink-3 hover:text-ink-2"}`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
