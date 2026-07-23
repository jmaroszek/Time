import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type FocusEventHandler,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import { Spinner, TrashButton } from "../components/ui";
import { displayBrowserProcesses, normalizeBrowserProcesses } from "../lib/browsers";
import { getDbPath } from "../lib/db";
import { explainDbError } from "../lib/dbErrors";
import { fmtDuration } from "../lib/format";
import {
  backupDatabase,
  countSessionsOlderThan,
  deleteHistoryBefore,
  eraseAllHistory,
  fetchSettings,
  listTrackingExclusions,
  fetchTrackerStatus,
  restoreDefaultSettings,
  updateSetting,
  type TrackerStatus,
} from "../lib/queries";
import { useBanner } from "../state/banner";
import { useMeta } from "../state/meta";

interface NumericSpec {
  key: string;
  min: number;
  max: number;
  scale: number;
  step?: number;
}

// UI clamp ranges. The tracker separately clamps what it consumes in
// tracker/db.py get_settings — keep the two in sight of each other.
const SPECS = {
  goal: { key: "weekly_goal_hours", min: 0, max: 100, scale: 1 },
  minimum: { key: "min_app_seconds_per_day", min: 0, max: 30, scale: 60 },
  start: { key: "day_start_hour", min: 0, max: 23, scale: 1 },
  end: { key: "day_end_hour", min: 1, max: 24, scale: 1 },
  idle: { key: "idle_threshold_seconds", min: 1, max: 60, scale: 60 },
  focus: { key: "focus_chain_max_gap_seconds", min: 0, max: 30, scale: 60 },
  heartbeat: { key: "heartbeat_seconds", min: 5, max: 300, scale: 1, step: 5 },
  noiseTime: { key: "activity_noise_max_seconds", min: 0, max: 30, scale: 60, step: 0.5 },
  noiseSessions: { key: "activity_noise_max_sessions", min: 1, max: 20, scale: 1 },
} satisfies Record<string, NumericSpec>;

const NOISE_MODE_LABELS: Record<string, string> = {
  off: "Off",
  one_off: "Rare items",
  utilities: "Rare items + utilities",
};

const TRACKER_HEALTH_STALE_SECONDS = 8;
const TRACKER_STATUS_POLL_MS = 2_000;

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

  useEffect(() => {
    const next = { ...meta.settings };
    for (const spec of Object.values(SPECS)) next[spec.key] = displayValue(spec, meta.settings[spec.key]);
    next.browser_processes = displayBrowserProcesses(meta.settings.browser_processes ?? "");
    setDrafts(next);
  }, [meta.settings]);

  const [pause, setPause] = useState<{ paused: boolean; until: number }>({ paused: false, until: 0 });
  useEffect(() => {
    const loadStatus = () => {
      void fetchTrackerStatus().then(setStatus).catch(() => setStatus(null));
    };
    loadStatus();
    const id = setInterval(loadStatus, TRACKER_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const loadPause = () => {
      // Pause is flipped from the tray, outside meta.refresh — poll it here.
      void fetchSettings()
        .then((s) => {
          const until = Number(s.tracking_paused_until) || 0;
          setPause({
            paused: s.tracking_paused === "1" || until > Date.now() / 1000,
            until,
          });
        })
        .catch(() => {});
    };
    loadPause();
    const id = setInterval(loadPause, 15_000);
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
  const saveText = async (key: string, normalize?: (raw: string) => string) => {
    const value = normalize ? normalize(drafts[key] ?? "") : (drafts[key] ?? "").trim();
    if (!value) {
      const fallback = key === "browser_processes"
        ? displayBrowserProcesses(meta.settings[key] ?? "")
        : (meta.settings[key] ?? "");
      setDrafts((current) => ({ ...current, [key]: fallback }));
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

  const heartbeatAge = status?.lastHeartbeat == null || status.lastHeartbeat <= 0
    ? null
    : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < TRACKER_HEALTH_STALE_SECONDS;
  const trackingEnabled = meta.settings.recording_consent === "1";

  const setTrackingEnabled = async (enabled: boolean) => {
    try {
      await updateSetting("recording_consent", enabled ? "1" : "0");
      if (enabled) await invoke("start_tracker");
      else {
        await updateSetting("launch_at_login", "0");
        await invoke("set_launch_at_login", { enabled: false });
      }
      await meta.refresh();
    } catch (e) {
      banner.report(e, "tracking preference");
    }
  };

  const setStartAtLogin = async (enabled: boolean) => {
    try {
      await invoke("set_launch_at_login", { enabled });
      await updateSetting("launch_at_login", enabled ? "1" : "0");
      await meta.refresh();
    } catch (e) {
      banner.report(e, "startup preference");
    }
  };

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
    // One column, not two. Any masonry layout re-balances whenever a section
    // changes height, so a second column would make the page look uneven again
    // the next time a setting is added. Length is the only thing that grows here.
    <div className="mr-auto flex w-full max-w-[600px] flex-col gap-[26px] pt-2">
      <section>
        <SectionLabel>Tracker Status</SectionLabel>
        <div className="flex items-center gap-3 rounded-[13px] border border-edge bg-surface-dim px-[18px] py-4">
          <span className={`h-[9px] w-[9px] rounded-full ${!trackingEnabled ? "bg-ink-3" : pause.paused ? "bg-[#e0a53a]" : trackerLive ? "live-pulse bg-good-data" : "alert-pulse bg-bad"}`} />
          <div>
            <p className="text-[13px] font-semibold text-ink">
              {!trackingEnabled ? "Tracking disabled" : pause.paused ? "Tracking paused" : trackerLive ? "Tracker is live" : "Tracker not detected"}
            </p>
            <p className="mt-[3px] text-[11.5px] text-ink-3">
              {!trackingEnabled
                ? "No new activity is being recorded"
                : pause.paused
                ? pause.until > Date.now() / 1000
                  ? `Resumes at ${new Date(pause.until * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — or sooner from the tray icon`
                  : "Resume from the tray icon"
                : trackerLive
                  ? "Collecting activity in real time"
                  : heartbeatAge === null
                    ? "Waiting for a tracker health signal"
                    : `No tracker heartbeat for ${fmtDuration(Math.max(heartbeatAge, 0))}`}
            </p>
          </div>
          {heartbeatAge !== null && <span className="ml-auto text-[11.5px] tabular-nums text-ink-3">last heartbeat {fmtDuration(Math.max(heartbeatAge, 0))} ago</span>}
        </div>
      </section>

      <Section title="Recording & startup">
        <Row
          label="Record activity"
          help="Allows the tracker to record foreground app names and timing."
          control={<PrivacyToggle enabled={trackingEnabled} onChange={(enabled) => void setTrackingEnabled(enabled)} />}
        />
        <Row
          label="Store window titles"
          help="Stores searchable window titles and enables Window rules for future activity. Turning it off leaves future titles blank; existing titles and App or Website rules still work. Titles may contain sensitive text. Off by default."
          control={
            <PrivacyToggle
              enabled={meta.settings.record_window_titles === "1"}
              onChange={(enabled) => selectSetting("record_window_titles", enabled ? "1" : "0")}
            />
          }
        />
        <Row
          label="Start at Windows sign-in"
          help="Starts the tracker when you sign in to Windows. Applies only to this account."
          control={
            <PrivacyToggle
              enabled={meta.settings.launch_at_login === "1"}
              disabled={!trackingEnabled}
              onChange={(enabled) => void setStartAtLogin(enabled)}
            />
          }
        />
        <ExclusionSummary />
      </Section>

      <Section title="Goals">
        <Row label="Weekly productive goal" help="Set 0 to leave goal pace unset." control={numberControl(SPECS.goal, "h")} />
      </Section>

      <Section title="Timeline Window">
        <Row label="Day starts at" help="First hour shown in Timeline and Rhythm. Activity outside this window still counts toward totals." control={numberControl(SPECS.start, undefined, true)} />
        <Row label="Day ends at" help="Last hour shown in Timeline and Rhythm. Activity outside this window still counts toward totals." control={numberControl(SPECS.end, undefined, true)} />
        <Row
          label="Week starts on"
          help="Affects weekly presets, weekly bucketing, and goal pacing."
          control={<Segmented options={["Sunday", "Monday"]} value={drafts.week_start === "auto" ? meta.weekStart : (drafts.week_start ?? meta.weekStart)} onChange={(value) => selectSetting("week_start", value)} />}
        />
      </Section>

      <Section title="Focus & Idle">
        <Row label="AFK idle threshold" help="No input for this long marks you AFK — watching video without touching the mouse or keyboard counts as away." control={numberControl(SPECS.idle, "min")} />
        <Row label="Focus chain max gap" help="Productive sessions separated by no more than this much untracked time count as one focus chain." control={numberControl(SPECS.focus, "min")} />
      </Section>

      <Section
        title="Activity list"
        intro="Hide brief, rarely seen items and system utilities from the Activity list. This never changes totals or Insights, and categorized items always remain visible."
      >
        <Row
          label="Hide list clutter"
          help="Choose whether to hide rare items, utilities, or neither."
          control={
            <Segmented
              options={["off", "one_off", "utilities"]}
              labels={NOISE_MODE_LABELS}
              value={drafts.activity_noise_filter ?? "utilities"}
              onChange={(value) => selectSetting("activity_noise_filter", value)}
            />
          }
        />
        <Row
          label="Rare-item time limit"
          help="Rare items must have less than this much recorded time across all history."
          control={numberControl(SPECS.noiseTime, "min")}
        />
        <Row
          label="Rare-item session limit"
          help="…and appear in no more than this many sessions across all history."
          control={numberControl(SPECS.noiseSessions, "sessions")}
        />
      </Section>

      <Section title="Advanced">
        <Row
          label="Minimum app time"
          help="Hides apps averaging less than this per tracked day from Insights' Top Apps."
          control={numberControl(SPECS.minimum, "min/day")}
        />
        <Row label="Heartbeat interval" help="How often the current session is saved; a crash can lose up to this much recent activity." control={numberControl(SPECS.heartbeat, "s")} />
        <Row
          label="Browser processes"
          help="Comma-separated processes treated as browsers for Website detection and Website or Window rules."
          control={
            <AutoGrowTextarea
              value={drafts.browser_processes ?? ""}
              onChange={(event) => setDrafts((current) => ({ ...current, browser_processes: event.target.value }))}
              onBlur={() => void saveText("browser_processes", (raw) => normalizeBrowserProcesses(raw).join(","))}
            />
          }
        />
      </Section>

      <RestoreDefaultsSection onRestored={() => setPause({ paused: false, until: 0 })} />
      <DataSection />
    </div>
  );
}

/** Privacy stays discoverable from Settings without Settings hosting the list:
 *  exclusions are per-entity curation, and that belongs with the other
 *  per-entity work in Activity. This row only says how many there are. */
function ExclusionSummary() {
  const [counts, setCounts] = useState<{ app: number; website: number } | null>(null);
  useEffect(() => {
    void listTrackingExclusions()
      .then((items) => setCounts({
        app: items.filter((item) => item.kind === "app").length,
        website: items.filter((item) => item.kind === "website").length,
      }))
      .catch(() => setCounts(null));
  }, []);
  if (counts === null) return null;
  const total = counts.app + counts.website;
  const parts = [
    `${counts.app} app${counts.app === 1 ? "" : "s"}`,
    `${counts.website} website${counts.website === 1 ? "" : "s"}`,
  ];
  return (
    <p className="border-t border-surface-2 px-4 py-[13px] text-xs leading-snug text-ink-3">
      {total === 0
        ? "Nothing is excluded from tracking — mark an app or website “Do not track” in Activity."
        : `${parts.join(" and ")} are never tracked — manage in Activity.`}
    </p>
  );
}

/** Both halves' versions, for diagnosing mismatched installs. The
 *  tracker stamps tracker_version into settings at startup. */
function VersionsLine({ trackerVersion }: { trackerVersion: string | undefined }) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  return (
    <p className="mt-2 text-[11px] text-ink-3">
      Dashboard {appVersion ?? "—"} · Tracker {trackerVersion ?? "not stamped yet"}
    </p>
  );
}

function RestoreDefaultsSection({ onRestored }: { onRestored: () => void }) {
  const meta = useMeta();
  const banner = useBanner();
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);

  const restore = async () => {
    const ok = window.confirm(
      "Restore every setting on this page to its default?\n\n" +
        "Recording and Windows startup will be turned off. Recorded history, categories, rules, aliases, exclusions, corrections, and backups will not change.",
    );
    if (!ok) return;
    setRestoring(true);
    setRestored(false);
    try {
      // Remove the external startup registration before the matching database
      // preference is reset, so a partial failure errs toward not launching.
      await invoke("set_launch_at_login", { enabled: false });
      await restoreDefaultSettings();
      await meta.refresh();
      onRestored();
      setRestored(true);
      setTimeout(() => setRestored(false), 2_000);
    } catch (error) {
      banner.report(error, "default settings");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Section title="Defaults">
      <Row
        label="Restore default settings"
        help="Resets every setting on this page without changing recorded history or organization."
        control={
          <button
            type="button"
            disabled={restoring}
            onClick={() => void restore()}
            className="rounded-[8px] border border-edge px-3 py-1.5 text-[11.5px] font-semibold text-ink-2 transition-colors hover:border-edge-2 hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            {restoring ? "Restoring…" : restored ? "Defaults restored" : "Restore defaults…"}
          </button>
        }
      />
    </Section>
  );
}

/** One card, one story: where the data lives, how to save it, how to shed it.
 *  Retention sits with backups because the safe order is back up, then delete —
 *  and it ends in the danger row so the destructive step is last, not floating
 *  in its own card. Lifecycle-level deletion stays in Settings; exact record
 *  correction lives in Activity. */
function DataSection() {
  const meta = useMeta();
  const banner = useBanner();
  const [olderDays, setOlderDays] = useState("365");
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupDetail, setBackupDetail] = useState<{ ok: boolean; text: string } | null>(null);

  const copyPath = () => void navigator.clipboard.writeText(getDbPath()).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });

  const backUpNow = () => {
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
  };

  const confirmAndDelete = async (
    count: number,
    what: string,
    run: () => Promise<unknown>,
  ): Promise<boolean> => {
    if (count === 0) {
      setMessage(`No recorded sessions ${what}.`);
      return false;
    }
    const ok = window.confirm(
      `Delete ${count} recorded session${count === 1 ? "" : "s"} ${what}?\n\n` +
        "This cannot be undone. Consider “Back up database now” first.",
    );
    if (!ok) return false;
    await run();
    setMessage(`Deleted ${count} session${count === 1 ? "" : "s"} ${what}.`);
    await meta.refresh();
    return true;
  };

  const deleteOlder = async () => {
    const days = Math.floor(Number(olderDays));
    if (!Number.isFinite(days) || days < 1) {
      setOlderDays("365");
      return;
    }
    try {
      const cutoff = Date.now() / 1000 - days * 86_400;
      const n = await countSessionsOlderThan(cutoff);
      await confirmAndDelete(n, `older than ${days} day${days === 1 ? "" : "s"}`, () =>
        deleteHistoryBefore(cutoff),
      );
    } catch (e) {
      banner.report(e, "deletion");
    }
  };

  const eraseEverything = async () => {
    const confirmation = window.prompt(
      "Erase every recorded session and compact the database? Categories and settings are kept.\n\n" +
        "This does not delete separate backup files. Type DELETE to continue.",
    );
    if (confirmation !== "DELETE") return;
    try {
      await updateSetting("recording_consent", "0");
      await updateSetting("launch_at_login", "0");
      await invoke("set_launch_at_login", { enabled: false });
      await invoke("stop_tracker");
      const n = await eraseAllHistory();
      setMessage(`Securely erased ${n} recorded session${n === 1 ? "" : "s"}. Separate backups were not deleted.`);
      await meta.refresh();
    } catch (e) {
      banner.report(e, "secure erase");
    }
  };

  return (
    <section>
      <SectionLabel>Data</SectionLabel>
      <div className="overflow-hidden rounded-[13px] border border-edge bg-surface-dim">
        <div className="p-4">
          <p className="mb-[9px] text-[11.5px] text-ink-3">Database path</p>
          <div className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 p-[9px] pl-[13px]">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={getDbPath()}>{getDbPath()}</span>
            <button
              type="button"
              className="rounded-[7px] border border-edge px-2.5 py-[5px] text-[11px] text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
              onClick={copyPath}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <button
            type="button"
            onClick={backUpNow}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-[10px] border border-accent/30 bg-gradient-to-b from-accent/15 to-accent/[.08] py-[11px] text-[12.5px] font-semibold text-accent shadow-[inset_0_1px_0_rgba(255,255,255,.05)] transition-colors hover:from-accent/25 hover:to-accent/15"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v11" /><path d="M7 9l5 5 5-5" /><path d="M4 20h16" />
            </svg>
            {backupMessage ?? "Back up database now"}
          </button>
          {backupDetail && (
            <p className={`mt-2 break-all text-[11px] ${backupDetail.ok ? "text-ink-3" : "text-bad"}`}>
              {backupDetail.text}
            </p>
          )}
          <p className="mt-3 text-[11px] leading-snug text-ink-3">
            Everything Time records stays in this file on your machine — nothing is ever uploaded.
          </p>
          <VersionsLine trackerVersion={meta.settings.tracker_version} />
        </div>
        <Row
          label="Delete history older than"
          help="Removes everything recorded before the cutoff. Categories and rules are kept."
          control={
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={olderDays}
                aria-label="Days of history to keep"
                onChange={(event) => setOlderDays(event.target.value)}
                className="w-[64px] rounded-[9px] border border-edge bg-surface-2 px-[11px] py-2 text-right text-xs text-ink outline-none focus:border-accent/60"
              />
              <span className="text-[11px] text-ink-3">days</span>
              <TrashButton label="Delete older history" onClick={() => void deleteOlder()} />
            </span>
          }
        />
        <div className="flex items-center justify-between gap-4 border-t border-surface-2 bg-bad/[.03] px-4 py-[13px]">
          <p className="text-xs text-ink-3">Securely erase all recorded history</p>
          <button
            type="button"
            className="shrink-0 text-xs font-semibold text-bad transition-colors hover:text-bad/80"
            onClick={() => void eraseEverything()}
          >
            Erase all…
          </button>
        </div>
        {message && <p className="border-t border-surface-2 px-4 py-3 text-[11.5px] text-ink-2">{message}</p>}
      </div>
    </section>
  );
}

function PrivacyToggle({
  enabled,
  disabled = false,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`relative h-6 w-11 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        enabled ? "border-accent/60 bg-accent/35" : "border-edge-2 bg-surface-2"
      }`}
    >
      <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-ink transition-all ${enabled ? "left-[22px]" : "left-[3px]"}`} />
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-3 pl-0.5 text-[11px] font-bold uppercase tracking-[.09em] text-ink-2">{children}</p>;
}

/** `intro` carries the rationale a whole section shares, so its rows can keep
 *  the one-sentence helps that make the column read evenly. */
function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      <div className="overflow-hidden rounded-[13px] border border-edge bg-surface-dim">
        {intro && <p className="px-4 pb-1 pt-3 text-[11px] leading-snug text-ink-3">{intro}</p>}
        {children}
      </div>
    </section>
  );
}

function Row({ label, help, control }: { label: string; help: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-surface-2 px-4 py-[15px] first:border-t-0">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="mt-[5px] max-w-[280px] text-xs leading-snug text-ink-3">{help}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function AutoGrowTextarea({
  value,
  onChange,
  onBlur,
}: {
  value: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  onBlur: FocusEventHandler<HTMLTextAreaElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    const minHeight = 36;
    const maxHeight = 94;
    field.style.height = "auto";
    field.style.height = `${Math.min(Math.max(field.scrollHeight, minHeight), maxHeight)}px`;
    field.style.overflowY = field.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label="Browser processes"
      spellCheck={false}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      className="w-[172px] resize-none rounded-[9px] border border-edge bg-surface-2 px-[11px] py-2 font-mono text-xs leading-relaxed text-ink outline-none focus:border-accent/60"
    />
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
    <div className="flex items-center rounded-[10px] border border-edge bg-surface-2 p-[3px]">
      <button type="button" className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-base text-ink-2 hover:bg-white/5 hover:text-ink" onClick={onMinus}>−</button>
      <div className={`flex items-baseline justify-center ${display ? "w-[46px]" : unit ? "min-w-[34px] gap-1" : "min-w-[34px]"}`}>
        <input
          type={readOnly ? "text" : "number"}
          readOnly={readOnly}
          value={display ?? value}
          style={unit ? { width: `${Math.max((display ?? value).length, 1)}ch` } : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className={`${unit ? "text-right" : "w-full text-center"} bg-transparent text-[13px] font-semibold tabular-nums text-ink outline-none`}
        />
        {unit && <span className="text-[11px] text-ink-3">{unit}</span>}
      </div>
      <button type="button" className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-base text-ink-2 hover:bg-white/5 hover:text-ink" onClick={onPlus}>+</button>
    </div>
  );
}

function Segmented({ options, value, onChange, labels }: { options: string[]; value: string; onChange: (value: string) => void; labels?: Record<string, string> }) {
  return (
    <div className="flex rounded-[10px] border border-edge bg-surface-2 p-[3px]">
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={`rounded-[7px] px-[13px] py-1.5 text-[11.5px] transition-colors ${value === option ? "bg-accent/15 font-semibold text-accent" : "text-ink-3 hover:text-ink-2"}`}
          onClick={() => onChange(option)}
        >
          {labels?.[option] ?? (option === "auto" ? "Auto" : option)}
        </button>
      ))}
    </div>
  );
}
