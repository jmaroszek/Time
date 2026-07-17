// Settings tab: every tunable lives in the DB settings table; the tracker
// re-reads them on each heartbeat, so changes apply without restarts.

import { useEffect, useState } from "react";

import { Button, Card, Select, Spinner, TextInput } from "../components/ui";
import { getDbPath } from "../lib/db";
import { fmtDuration } from "../lib/format";
import {
  backupDatabase,
  fetchTrackerStatus,
  updateSetting,
  type TrackerStatus,
} from "../lib/queries";
import { useMeta } from "../state/meta";

interface NumericFieldSpec {
  key: string;
  label: string;
  help: string;
  /** Bounds in DISPLAY units. */
  min: number;
  max: number;
  /** DB value = display value * scale (e.g. minutes shown, seconds stored). */
  scale: number;
}

const NUMERIC_FIELDS: NumericFieldSpec[] = [
  { key: "weekly_goal_hours", label: "Weekly productive goal (hours)", help: "Target the goal-pace card measures against.", min: 1, max: 100, scale: 1 },
  { key: "idle_threshold_seconds", label: "AFK idle threshold (minutes)", help: "No input for this long marks you AFK (back-dated to last input).", min: 1, max: 60, scale: 60 },
  { key: "heartbeat_seconds", label: "Heartbeat interval (seconds)", help: "How often the open session's end time is flushed. A crash loses at most this much.", min: 5, max: 300, scale: 1 },
  { key: "default_top_n_apps", label: "Default top apps shown", help: "Initial size of the Overview top-apps list.", min: 3, max: 50, scale: 1 },
  { key: "min_app_seconds", label: "Minimum app time (minutes)", help: "Apps with less time than this in the selected range are hidden from the app lists. Set 0 to show everything.", min: 0, max: 30, scale: 60 },
  { key: "focus_chain_max_gap_seconds", label: "Focus streak max gap (minutes)", help: "Gaps shorter than this between productive sessions don't break the Longest focus streak.", min: 0, max: 30, scale: 60 },
  { key: "day_start_hour", label: "Day starts at (hour)", help: "First hour shown on the Timeline and Hour-of-Day plots. 24-hour clock (6 = 6am). Earlier hours are hidden.", min: 0, max: 23, scale: 1 },
  { key: "day_end_hour", label: "Day ends at (hour)", help: "Last hour shown on those plots. 24-hour clock (24 = midnight). Later hours are hidden.", min: 1, max: 24, scale: 1 },
];

function toDisplay(spec: NumericFieldSpec, dbValue: string | undefined): string {
  const n = Number(dbValue);
  if (!Number.isFinite(n)) return "";
  return String(Math.round((n / spec.scale) * 100) / 100);
}

export default function SettingsTab() {
  const meta = useMeta();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);

  useEffect(() => {
    const next = { ...meta.settings };
    for (const spec of NUMERIC_FIELDS) next[spec.key] = toDisplay(spec, meta.settings[spec.key]);
    setDrafts(next);
  }, [meta.settings]);

  useEffect(() => {
    void fetchTrackerStatus().then(setStatus).catch(() => setStatus(null));
    const id = setInterval(() => {
      void fetchTrackerStatus().then(setStatus).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!meta.loaded) return <Spinner />;

  const commitNumeric = async (spec: NumericFieldSpec) => {
    const raw = Number(drafts[spec.key]);
    if (!Number.isFinite(raw)) {
      setDrafts((d) => ({ ...d, [spec.key]: toDisplay(spec, meta.settings[spec.key]) }));
      return;
    }
    const clamped = Math.min(Math.max(raw, spec.min), spec.max);
    await updateSetting(spec.key, String(Math.round(clamped * spec.scale)));
    await meta.refresh();
  };

  const commitText = async (key: string) => {
    const value = (drafts[key] ?? "").trim();
    if (!value) {
      setDrafts((d) => ({ ...d, [key]: meta.settings[key] }));
      return;
    }
    await updateSetting(key, value);
    await meta.refresh();
  };

  const heartbeatAge =
    status?.lastHeartbeat != null ? Date.now() / 1000 - status.lastHeartbeat : null;
  const trackerLive = heartbeatAge !== null && heartbeatAge < 120;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Tracking & Goals">
        <div className="flex flex-col gap-4">
          {NUMERIC_FIELDS.map((spec) => (
            <div key={spec.key}>
              <div className="flex items-center justify-between gap-4">
                <label className="text-xs text-ink">{spec.label}</label>
                <TextInput
                  type="number"
                  value={drafts[spec.key] ?? ""}
                  onChange={(v) => setDrafts((d) => ({ ...d, [spec.key]: v }))}
                  onCommit={() => void commitNumeric(spec)}
                  className="w-16 text-right"
                />
              </div>
              <p className="mt-0.5 text-[11px] text-ink-3">{spec.help}</p>
            </div>
          ))}
          <div>
            <div className="flex items-center justify-between gap-4">
              <label className="text-xs text-ink">Week starts on</label>
              <Select
                value={meta.settings.week_start ?? "Sunday"}
                onChange={(v) =>
                  void updateSetting("week_start", v).then(() => meta.refresh())
                }
                options={[
                  { value: "Sunday", label: "Sunday" },
                  { value: "Monday", label: "Monday" },
                ]}
                className="w-24"
              />
            </div>
            <p className="mt-0.5 text-[11px] text-ink-3">
              Affects weekly presets, trends, and goal pacing.
            </p>
          </div>
          <div>
            <div className="flex items-center justify-between gap-4">
              <label className="text-xs text-ink">Browser processes</label>
              <TextInput
                value={drafts.browser_processes ?? ""}
                onChange={(v) => setDrafts((d) => ({ ...d, browser_processes: v }))}
                onCommit={() => void commitText("browser_processes")}
                className="w-64"
              />
            </div>
            <p className="mt-0.5 text-[11px] text-ink-3">
              Comma-separated. Domain/title rules and domain capture apply to these.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Tracker & Database">
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${trackerLive ? "bg-good" : "bg-bad"}`}
            />
            <span className="font-medium">
              {trackerLive ? "Tracker is live" : "Tracker not detected"}
            </span>
            {heartbeatAge !== null && (
              <span className="text-ink-3">
                last heartbeat {fmtDuration(Math.max(heartbeatAge, 0))} ago
              </span>
            )}
          </div>
          <InfoRow label="Database" value={getDbPath()} mono />
          {status && (
            <>
              <InfoRow
                label="Sessions"
                value={`${status.totalSessionCount.toLocaleString()} total · ${status.liveSessionCount.toLocaleString()} live`}
              />
            </>
          )}
          <div className="mt-2 border-t border-edge pt-3">
            <Button
              variant="primary"
              onClick={() =>
                void backupDatabase()
                  .then((p) => setBackupMsg(`Backup written: ${p}`))
                  .catch((e) => setBackupMsg(`Backup failed: ${e}`))
              }
            >
              Back up database now
            </Button>
            {backupMsg && <p className="mt-2 break-all text-[11px] text-ink-2">{backupMsg}</p>}
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            Settings save on Enter or focus-out. The tracker picks them up within one heartbeat —
            no restart needed.
          </p>
        </div>
      </Card>
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-ink-3">{label}</span>
      <span className={`break-all text-ink-2 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}
