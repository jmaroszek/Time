import { useEffect, useState, type ReactNode } from "react";

import { Spinner } from "../components/ui";
import { getDbPath } from "../lib/db";
import { explainDbError } from "../lib/dbErrors";
import { fmtDuration } from "../lib/format";
import { backupDatabase, fetchTrackerStatus, updateSetting, type TrackerStatus } from "../lib/queries";
import { useBanner } from "../state/banner";
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
  const banner = useBanner();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupDetail, setBackupDetail] = useState<{ ok: boolean; text: string } | null>(null);

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
    try {
      await updateSetting(spec.key, String(Math.round(clamped * spec.scale)));
      await meta.refresh();
    } catch (e) {
      banner.report(e, "setting");
    }
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
    try {
      await updateSetting(key, value);
      await meta.refresh();
    } catch (e) {
      banner.report(e, "setting");
    }
  };
  const selectSetting = (key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
    void updateSetting(key, value)
      .then(meta.refresh)
      .catch((e: unknown) => banner.report(e, "setting"));
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
    <div className="grid grid-cols-2 items-start gap-6">
      <div className="flex flex-col gap-[26px]">
        <Section title="Goals">
          <Row label="Weekly productive goal" help="Target the goal-pace card measures against." control={numberControl(SPECS.goal, "h")} />
        </Section>

        <Section title="Timeline Window">
          <Row label="Day starts at" help="First hour shown on Timeline & Hour-of-Day plots." control={numberControl(SPECS.start, undefined, true)} />
          <Row label="Day ends at" help="Last hour shown on Timeline & Hour-of-Day plots." control={numberControl(SPECS.end, undefined, true)} />
          <Row
            label="Week starts on"
            help="Affects weekly presets, trends, and goal pacing."
            control={<Segmented options={["Sunday", "Monday"]} value={drafts.week_start ?? "Sunday"} onChange={(value) => selectSetting("week_start", value)} />}
          />
        </Section>

        <Section title="Focus & Idle">
          <Row label="AFK idle threshold" help="No input for this long marks you AFK — watching video without touching the mouse or keyboard counts as away." control={numberControl(SPECS.idle, "min")} />
          <Row label="Focus streak max gap" help="Short gaps won't break a productive streak." control={numberControl(SPECS.focus, "min")} />
        </Section>

        <Section title="App Lists">
          <Row
            label="Default top apps shown"
            help="Initial size of the Overview top-apps list."
            control={<Segmented options={["5", "10", "15", "20"]} value={drafts.default_top_n_apps ?? "5"} onChange={(value) => selectSetting("default_top_n_apps", value)} />}
          />
          <Row label="Minimum app time" help="Apps below this in the range are hidden from the lists. 0 shows everything." control={numberControl(SPECS.minimum, "min")} />
        </Section>
      </div>

      <div className="flex flex-col gap-[26px]">
        <section>
          <SectionLabel>Tracker Status</SectionLabel>
          <div className="flex items-center gap-3 rounded-[13px] border border-[#23272e] bg-[#131519] px-[18px] py-4">
            <span className={`h-[9px] w-[9px] rounded-full ${trackerLive ? "live-pulse bg-[#16b981]" : "bg-bad"}`} />
            <div>
              <p className="text-[13px] font-semibold text-[#eef0f3]">{trackerLive ? "Tracker is live" : "Tracker not detected"}</p>
              <p className="mt-[3px] text-[11.5px] text-[#7b818b]">{trackerLive ? "Collecting activity in real time" : "No heartbeat in the last two minutes"}</p>
            </div>
            {heartbeatAge !== null && <span className="ml-auto text-[11.5px] tabular-nums text-ink-3">last heartbeat {fmtDuration(Math.max(heartbeatAge, 0))} ago</span>}
          </div>
        </section>

        <section>
          <SectionLabel>Database</SectionLabel>
          <div className="rounded-[13px] border border-[#23272e] bg-[#131519] p-4">
            <p className="mb-[9px] text-[11.5px] text-[#7b818b]">Database path</p>
            <div className="flex items-center gap-2 rounded-[10px] border border-[#2c313a] bg-[#191c22] p-[9px] pl-[13px]">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#aab0b8]" title={getDbPath()}>{getDbPath()}</span>
              <button
                type="button"
                className="rounded-[7px] border border-[#2c313a] px-2.5 py-[5px] text-[11px] text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
                onClick={() => void navigator.clipboard.writeText(getDbPath()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <button
              type="button"
              onClick={() => {
                setBackupMessage(null);
                setBackupDetail(null);
                void backupDatabase()
                  .then((target) => {
                    setBackupMessage("✓ Backup written");
                    setBackupDetail({ ok: true, text: `Saved to ${target}` });
                    setTimeout(() => setBackupMessage(null), 2000);
                  })
                  .catch((e: unknown) => {
                    setBackupMessage("Backup failed");
                    setBackupDetail({ ok: false, text: explainDbError(e, "backup") });
                  });
              }}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-[10px] border border-accent/30 bg-gradient-to-b from-accent/15 to-accent/[.08] py-[11px] text-[12.5px] font-semibold text-[#9cc0ea] shadow-[inset_0_1px_0_rgba(255,255,255,.05)] transition-colors hover:from-accent/25 hover:to-accent/15"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v11" /><path d="M7 9l5 5 5-5" /><path d="M4 20h16" />
              </svg>
              {backupMessage ?? "Back up database now"}
            </button>
            {backupDetail && (
              <p className={`mt-2 break-all text-[11px] ${backupDetail.ok ? "text-[#7b818b]" : "text-bad"}`}>
                {backupDetail.text}
              </p>
            )}
            <p className="mt-3 text-[11px] leading-snug text-[#7b818b]">
              Everything Time records stays in this file on your machine — nothing is ever
              uploaded. To restore a backup: quit the tracker and dashboard, replace the
              database file with the backup copy, then restart (full steps in docs/restore.md).
            </p>
          </div>
        </section>

        <section>
          <SectionLabel>Advanced</SectionLabel>
          <div className="overflow-hidden rounded-[13px] border border-[#23272e] bg-[#131519]">
            <Row label="Heartbeat interval" help="How often the active session is flushed." control={numberControl(SPECS.heartbeat, "s")} />
            <Row
              label="Browser processes"
              help="Comma-separated. Splitting browser time by site needs a “URL in title” extension installed in the browser; without one, browser time is tracked per app only."
              control={
                <input
                  value={drafts.browser_processes ?? ""}
                  onChange={(event) => setDrafts((current) => ({ ...current, browser_processes: event.target.value }))}
                  onBlur={() => void saveText("browser_processes")}
                  onKeyDown={(event) => { if (event.key === "Enter") void saveText("browser_processes"); }}
                  className="w-[150px] rounded-[9px] border border-[#2c313a] bg-[#191c22] px-[11px] py-2 font-mono text-xs text-[#eef0f3] outline-none focus:border-accent/60"
                />
              }
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-3 pl-0.5 text-[11px] font-bold uppercase tracking-[.09em] text-ink-2">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      <div className="overflow-hidden rounded-[13px] border border-[#23272e] bg-[#131519]">{children}</div>
    </section>
  );
}

function Row({ label, help, control }: { label: string; help: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-[#1e2127] px-4 py-[15px] first:border-t-0">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[#eef0f3]">{label}</p>
        <p className="mt-[5px] max-w-[280px] text-xs leading-snug text-[#7b818b]">{help}</p>
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
    <div className="flex items-center rounded-[10px] border border-[#2c313a] bg-[#191c22] p-[3px]">
      <button type="button" className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-base text-ink-2 hover:bg-white/5 hover:text-ink" onClick={onMinus}>−</button>
      <div className={`flex items-baseline justify-center ${unit ? "min-w-[48px] gap-1.5" : "min-w-[48px]"}`}>
        <input
          type={readOnly ? "text" : "number"}
          readOnly={readOnly}
          value={display ?? value}
          style={unit ? { width: `${Math.max((display ?? value).length, 1)}ch` } : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className={`${unit ? "text-right" : "w-full text-center"} bg-transparent text-[13px] font-semibold tabular-nums text-[#eef0f3] outline-none`}
        />
        {unit && <span className="text-[11px] text-[#7b818b]">{unit}</span>}
      </div>
      <button type="button" className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-base text-ink-2 hover:bg-white/5 hover:text-ink" onClick={onPlus}>+</button>
    </div>
  );
}

function Segmented({ options, value, onChange }: { options: string[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex rounded-[10px] border border-[#2c313a] bg-[#191c22] p-[3px]">
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={`rounded-[7px] px-[13px] py-1.5 text-[11.5px] transition-colors ${value === option ? "bg-accent/15 font-semibold text-[#88b3e6]" : "text-[#7b818b] hover:text-ink-2"}`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
