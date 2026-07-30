import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import { Button, ConfirmDialog, Spinner, TrashButton } from "../components/ui";
import { displayBrowserProcesses, normalizeBrowserProcesses } from "../lib/browsers";
import { getDbPath } from "../lib/db";
import { explainDbError } from "../lib/dbErrors";
import { fmtDuration } from "../lib/format";
import { KeyedSerialQueue } from "../lib/keyedSerialQueue";
import {
  hidesRareItems,
  hidesUtilities,
  noiseModeFor,
  type NoiseMode,
} from "../lib/noise";
import {
  paletteForTheme,
  PALETTES,
  previewSwatches,
  PRODUCTIVITY_OPTIONS,
  type ProductivityOption,
} from "../lib/palettes";
import {
  resolveThemePreference,
  THEME_PREFERENCE_LABELS,
  THEME_PREFERENCES,
} from "../lib/theme";
import {
  backupDatabase,
  chooseDatabaseBackupFile,
  countSessionsOlderThan,
  deleteHistoryBefore,
  eraseAllHistory,
  fetchSettings,
  fetchTrackerStatus,
  inspectDatabaseBackup,
  listDatabaseBackups,
  listTrackingExclusions,
  restoreDefaultSettings,
  restoreDatabase,
  updateSetting,
  type DatabaseBackup,
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
const SPECS_BY_KEY = new Map(
  Object.values(SPECS).map((spec) => [spec.key, spec]),
);

const TRACKER_HEALTH_STALE_SECONDS = 8;
const TRACKER_STATUS_POLL_MS = 2_000;
const TRACKER_START_TIMEOUT_MS = 10_000;

function trackerHeartbeatIsLive(status: TrackerStatus): boolean {
  return status.lastHeartbeat !== null
    && status.lastHeartbeat > 0
    && Date.now() / 1000 - status.lastHeartbeat < TRACKER_HEALTH_STALE_SECONDS;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayValue(spec: NumericSpec, raw: string | undefined): string {
  const value = Number(raw);
  return Number.isFinite(value) ? String(Math.round((value / spec.scale) * 100) / 100) : "";
}

function settingDraftValue(
  key: string,
  settings: Record<string, string>,
): string {
  const spec = SPECS_BY_KEY.get(key);
  if (spec) return displayValue(spec, settings[key]);
  if (key === "browser_processes") {
    return displayBrowserProcesses(settings[key] ?? "");
  }
  return settings[key] ?? "";
}

function clockHour(value: number): string {
  const normalized = value % 24;
  return `${normalized % 12 || 12} ${normalized < 12 ? "AM" : "PM"}`;
}

function resolvedNoiseMode(raw: string | undefined): NoiseMode {
  return raw === "off"
    || raw === "one_off"
    || raw === "utilities_only"
    || raw === "utilities"
    ? raw
    : "utilities";
}

function handleRadioKey(
  event: KeyboardEvent<HTMLButtonElement>,
  options: string[],
  index: number,
  onChange: (value: string) => void,
) {
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  else return;
  event.preventDefault();
  onChange(options[next]);
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
  radios?.[next]?.focus();
}

function trapModalFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

type SaveOutcome = "idle" | "saved" | "failed";

export default function SettingsTab({
  onManageExclusions,
  onManageCategories,
}: {
  onManageExclusions: () => void;
  onManageCategories: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [startingTracker, setStartingTracker] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>("idle");
  const writeQueueRef = useRef(new KeyedSerialQueue());
  const writeSequenceRef = useRef(0);
  const latestWriteRef = useRef(new Map<string, number>());
  const optimisticDraftsRef = useRef(new Map<string, string>());
  const immediateActionsRef = useRef(new Set<string>());
  const saveOutcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = { ...meta.settings };
    for (const spec of Object.values(SPECS)) next[spec.key] = displayValue(spec, meta.settings[spec.key]);
    next.browser_processes = displayBrowserProcesses(meta.settings.browser_processes ?? "");
    for (const [key, value] of optimisticDraftsRef.current) next[key] = value;
    setDrafts(next);
  }, [meta.settings]);
  useEffect(() => () => {
    if (saveOutcomeTimerRef.current) clearTimeout(saveOutcomeTimerRef.current);
  }, []);

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

  const markSaving = (key: string) => {
    setSavingKeys((current) => new Set(current).add(key));
    setSaveOutcome("idle");
    if (saveOutcomeTimerRef.current) clearTimeout(saveOutcomeTimerRef.current);
  };
  const markFinished = (key: string, outcome: Exclude<SaveOutcome, "idle">) => {
    setSavingKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setSaveOutcome(outcome);
    if (saveOutcomeTimerRef.current) clearTimeout(saveOutcomeTimerRef.current);
    saveOutcomeTimerRef.current = setTimeout(() => setSaveOutcome("idle"), 1_800);
  };
  const reconcileSetting = async (
    key: string,
    sequence: number,
    outcome: Exclude<SaveOutcome, "idle">,
    error?: unknown,
    context = "setting",
  ) => {
    if (latestWriteRef.current.get(key) !== sequence) return;
    if (error !== undefined) banner.report(error, context);
    try {
      const settings = await fetchSettings();
      if (latestWriteRef.current.get(key) !== sequence) return;
      optimisticDraftsRef.current.delete(key);
      setDrafts((current) => ({
        ...current,
        [key]: settingDraftValue(key, settings),
      }));
      await meta.refresh();
    } catch (refreshError) {
      banner.report(refreshError, "settings refresh");
      if (latestWriteRef.current.get(key) === sequence) {
        optimisticDraftsRef.current.delete(key);
        setDrafts((current) => ({
          ...current,
          [key]: settingDraftValue(key, meta.settings),
        }));
      }
    }
    if (latestWriteRef.current.get(key) !== sequence) return;
    latestWriteRef.current.delete(key);
    markFinished(key, outcome);
  };
  const queueSetting = (
    key: string,
    storedValue: string,
    draftValue = storedValue,
    context = "setting",
  ) => {
    const sequence = ++writeSequenceRef.current;
    latestWriteRef.current.set(key, sequence);
    optimisticDraftsRef.current.set(key, draftValue);
    setDrafts((current) => ({ ...current, [key]: draftValue }));
    markSaving(key);
    const operation = writeQueueRef.current.run(key, () =>
      updateSetting(key, storedValue),
    );
    void operation.then(
      () => reconcileSetting(key, sequence, "saved", undefined, context),
      (error: unknown) => reconcileSetting(key, sequence, "failed", error, context),
    );
  };
  const runImmediateSettingAction = async (
    key: string,
    action: () => Promise<void>,
    context: string,
  ) => {
    if (immediateActionsRef.current.has(key)) return;
    immediateActionsRef.current.add(key);
    markSaving(key);
    let outcome: Exclude<SaveOutcome, "idle"> = "saved";
    try {
      await action();
    } catch (error) {
      outcome = "failed";
      banner.report(error, context);
    }
    try {
      await meta.refresh();
    } catch (refreshError) {
      outcome = "failed";
      banner.report(refreshError, "settings refresh");
    } finally {
      immediateActionsRef.current.delete(key);
      markFinished(key, outcome);
    }
  };

  const saveNumeric = (spec: NumericSpec, requested?: number) => {
    const raw = requested ?? Number(drafts[spec.key]);
    const fallback = Number(displayValue(spec, meta.settings[spec.key]));
    const valid = Number.isFinite(raw) ? raw : fallback;
    const clamped = Math.min(Math.max(valid, spec.min), spec.max);
    const storedValue = String(Math.round(clamped * spec.scale));
    const draftValue = String(clamped);
    const pendingDraft = optimisticDraftsRef.current.get(spec.key);
    if (
      pendingDraft === draftValue
      || (pendingDraft === undefined && storedValue === (meta.settings[spec.key] ?? ""))
    ) {
      setDrafts((current) => ({ ...current, [spec.key]: draftValue }));
      return;
    }
    queueSetting(spec.key, storedValue, draftValue);
  };
  const step = (spec: NumericSpec, direction: -1 | 1) => {
    const current = Number(
      optimisticDraftsRef.current.get(spec.key) ?? drafts[spec.key],
    );
    const fallback = Number(displayValue(spec, meta.settings[spec.key])) || spec.min;
    saveNumeric(spec, (Number.isFinite(current) ? current : fallback) + direction * (spec.step ?? 1));
  };
  const saveBrowserProcesses = (processes: string[]) => {
    const storedValue = normalizeBrowserProcesses(processes.join(",")).join(",");
    if (!storedValue) return;
    const draftValue = displayBrowserProcesses(storedValue);
    const pendingDraft = optimisticDraftsRef.current.get("browser_processes");
    if (
      pendingDraft === draftValue
      || (
        pendingDraft === undefined
        && storedValue === (meta.settings.browser_processes ?? "")
      )
    ) {
      setDrafts((current) => ({ ...current, browser_processes: draftValue }));
      return;
    }
    queueSetting("browser_processes", storedValue, draftValue);
  };
  const selectSetting = (key: string, value: string) => {
    const pendingDraft = optimisticDraftsRef.current.get(key);
    if (
      pendingDraft === value
      || (pendingDraft === undefined && value === (meta.settings[key] ?? ""))
    ) return;
    queueSetting(key, value);
  };

  const heartbeatAge = status?.lastHeartbeat == null || status.lastHeartbeat <= 0
    ? null
    : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < TRACKER_HEALTH_STALE_SECONDS;
  const trackingEnabled = meta.settings.recording_consent === "1";
  const trackerLabel = !trackingEnabled
    ? "Tracking disabled"
    : !trackerLive
      ? "Tracker not detected"
      : pause.paused
        ? "Tracking paused"
        : "Tracker is live";
  const trackerDetail = !trackingEnabled
    ? "No new activity is being recorded"
    : !trackerLive
      ? heartbeatAge === null
        ? "Waiting for a tracker health signal"
        : `No tracker heartbeat for ${fmtDuration(Math.max(heartbeatAge, 0))}`
      : pause.paused
        ? pause.until > Date.now() / 1000
          ? `Resumes at ${new Date(pause.until * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — or sooner from the tray icon`
          : "Resume from the tray icon"
        : "Collecting activity in real time";
  const noiseMode = resolvedNoiseMode(drafts.activity_noise_filter);
  const hideRare = hidesRareItems(noiseMode);
  const hideUtilities = hidesUtilities(noiseMode);
  const setNoiseVisibility = (rare: boolean, utilities: boolean) =>
    selectSetting("activity_noise_filter", noiseModeFor(rare, utilities));

  const setTrackingEnabled = async (enabled: boolean) => {
    await runImmediateSettingAction("recording_consent", async () => {
      await updateSetting("recording_consent", enabled ? "1" : "0");
      if (enabled) await invoke("start_tracker");
      else {
        await updateSetting("launch_at_login", "0");
        await invoke("set_launch_at_login", { enabled: false });
      }
    }, "tracking preference");
  };

  const setStartAtLogin = async (enabled: boolean) => {
    await runImmediateSettingAction("launch_at_login", async () => {
      await invoke("set_launch_at_login", { enabled });
      await updateSetting("launch_at_login", enabled ? "1" : "0");
    }, "startup preference");
  };

  const startTracker = async () => {
    if (startingTracker) return;
    setStartingTracker(true);
    try {
      await invoke("start_tracker");
      const deadline = Date.now() + TRACKER_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const next = await fetchTrackerStatus();
        setStatus(next);
        if (trackerHeartbeatIsLive(next)) {
          banner.show("Tracker started");
          return;
        }
        await wait(500);
      }
      throw new Error("The tracker started but did not report a health signal");
    } catch (error) {
      banner.report(error, "tracker startup");
    } finally {
      setStartingTracker(false);
    }
  };

  const themedChoice = (choice: ProductivityOption) =>
    meta.theme === "light" ? choice.light : choice;

  const numberControl = (spec: NumericSpec, label: string, unit?: string, hour = false) => (
    <NumberStepper
      label={label}
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
    // One column of settings, not two. Any masonry layout re-balances whenever a
    // section changes height, so a second column would make the page look uneven
    // again the next time a setting is added. Length is the only thing that grows
    // here — which is what the rail beside it addresses, without taking width
    // from the column or reflowing it.
    <div className="settings-panel mr-auto flex w-full max-w-[774px] gap-6 pt-2">
      <div className="flex min-w-0 w-full max-w-[600px] flex-col gap-[26px]">
      <SettingsSection title="Tracker status">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel>Tracker status</SectionLabel>
          <p
            className={`mb-3 min-h-4 text-xs ${
              savingKeys.size > 0
                ? "text-ink-2"
                : saveOutcome === "failed"
                  ? "text-bad"
                  : "text-ink-3"
            }`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {savingKeys.size === 0
              ? saveOutcome === "saved"
                ? "All changes saved"
                : saveOutcome === "failed"
                  ? "A change was not saved"
                  : ""
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-[13px] border border-edge bg-surface-dim px-4 py-4 sm:px-[18px]">
          <span className={`h-[9px] w-[9px] rounded-full ${!trackingEnabled ? "bg-ink-3" : !trackerLive ? "alert-pulse bg-bad" : pause.paused ? "bg-warn" : "live-pulse bg-good-data"}`} />
          <div className="min-w-0">
            <p className="text-row font-semibold text-ink">
              {trackerLabel}
            </p>
            <p className="mt-[3px] text-xs text-ink-3">
              {trackerDetail}
            </p>
          </div>
          {!trackingEnabled || trackerLive ? (
            heartbeatAge !== null && (
              <span className="basis-full text-xs tabular-nums text-ink-3 sm:ml-auto sm:basis-auto">
                last heartbeat {fmtDuration(Math.max(heartbeatAge, 0))} ago
              </span>
            )
          ) : (
            <div className="basis-full sm:ml-auto sm:basis-auto">
              <Button
                variant="primary"
                disabled={startingTracker}
                onClick={() => void startTracker()}
              >
                {startingTracker ? "Starting…" : "Start tracker"}
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      <Section title="Recording & startup">
        <Row
          label="Record activity"
          help="Allows the tracker to record app names and times"
          control={<PrivacyToggle label="Record activity" enabled={trackingEnabled} disabled={savingKeys.has("recording_consent") || savingKeys.has("launch_at_login")} onChange={(enabled) => void setTrackingEnabled(enabled)} />}
        />
        <Row
          label="Store window titles"
          help="Stores window titles in the database. This enables window-based classification rules, but stored data may contain sensitive information."
          control={
            <PrivacyToggle
              label="Store window titles"
              enabled={(drafts.record_window_titles ?? meta.settings.record_window_titles) === "1"}
              onChange={(enabled) => selectSetting("record_window_titles", enabled ? "1" : "0")}
            />
          }
        />
        <Row
          label="Start at Windows sign-in"
          help="Start the tracker when you sign into this Windows account."
          control={
            <span className="inline-flex flex-col items-start gap-1">
              <PrivacyToggle
                label="Start at Windows sign-in"
                enabled={meta.settings.launch_at_login === "1"}
                disabled={!trackingEnabled || savingKeys.has("recording_consent") || savingKeys.has("launch_at_login")}
                onChange={(enabled) => void setStartAtLogin(enabled)}
              />
              {!trackingEnabled && (
                <span className="text-xs text-ink-3">
                  Enable Record activity first
                </span>
              )}
            </span>
          }
        />
        <Row
          label="Show tray icon"
          help="Show tracker controls in the Windows notification area."
          control={
            <PrivacyToggle
              label="Show tray icon"
              enabled={(drafts.show_tray_icon ?? meta.settings.show_tray_icon ?? "1") !== "0"}
              disabled={savingKeys.has("show_tray_icon")}
              onChange={(enabled) => selectSetting("show_tray_icon", enabled ? "1" : "0")}
            />
          }
        />
        <ExclusionSummary onManage={onManageExclusions} />
      </Section>

      <Section title="Goals">
        <Row label="Weekly productive goal" help="Set 0 to leave goal pace unset." control={numberControl(SPECS.goal, "Weekly productive goal", "h")} />
      </Section>

      <Section title="Timeline window">
        <Row label="Day starts at" help="First hour shown in Timeline and Rhythm. Activity outside this window still counts toward totals." control={numberControl(SPECS.start, "Day starts at", undefined, true)} />
        <Row label="Day ends at" help="Last hour shown in Timeline and Rhythm. Activity outside this window still counts toward totals." control={numberControl(SPECS.end, "Day ends at", undefined, true)} />
        <Row
          label="Week starts on"
          help="Affects weekly presets, bucketing, and goal pacing."
          control={<Segmented label="Week starts on" options={["Sunday", "Monday"]} value={drafts.week_start === "auto" ? meta.weekStart : (drafts.week_start ?? meta.weekStart)} onChange={(value) => selectSetting("week_start", value)} />}
        />
      </Section>

      <Section title="Focus & idle">
        <Row label="AFK idle threshold" help="No input for this long marks you as Away From Keyboard (AFK). Time will not mark you idle if it detects media playing in the foreground window. AFK time is not classified and does not count towards computer use." control={numberControl(SPECS.idle, "AFK idle threshold", "min")} />
        <Row label="Focus chain max gap" help="Bridges untracked gaps up to this long between productive sessions. Neutral and uncategorized activity preserve the chain without adding to its duration; unproductive or AFK time ends it immediately." control={numberControl(SPECS.focus, "Focus chain max gap", "min")} />
      </Section>

      <Section
        title="Appearance"
        intro="The app's theme, and the category and productivity colors used across every chart. Switching palettes changes the swatches offered for new categories."
      >
        <Row
          label="Theme"
          help="Follow system uses your Windows light or dark setting, and follows it when it changes."
          control={
            <Segmented
              label="Theme"
              options={THEME_PREFERENCES}
              labels={THEME_PREFERENCE_LABELS}
              value={resolveThemePreference(drafts.theme ?? meta.themePreference)}
              onChange={(value) => selectSetting("theme", value)}
            />
          }
        />
        <div className="border-t border-surface-2 px-4 pb-4 pt-4">
          <p id="category-palette-label" className="mb-2 text-micro font-semibold uppercase tracking-wide text-ink-3">
            Category palette
          </p>
          <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby="category-palette-label">
            {PALETTES.map((option, index) => {
              const selected = (drafts.color_palette ?? meta.palette.id) === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectSetting("color_palette", option.id)}
                  onKeyDown={(event) =>
                    handleRadioKey(event, PALETTES.map((palette) => palette.id), index, (value) =>
                      selectSetting("color_palette", value),
                    )}
                  className={`flex items-center gap-3 rounded-[11px] border px-3 py-2.5 text-left transition-colors ${selected ? "border-accent/70 bg-surface-3" : "border-edge bg-surface-2 hover:bg-surface-3"}`}
                >
                  <span className="flex shrink-0 gap-1" aria-hidden="true">
                    {previewSwatches(paletteForTheme(option, meta.theme)).map((swatch) => (
                      <span key={swatch} className="h-4 w-4 rounded" style={{ backgroundColor: swatch }} />
                    ))}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-row font-semibold text-ink">{option.label}</span>
                    <span className="block text-xs leading-snug text-ink-3">{option.description}</span>
                  </span>
                  <span className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-accent" : "border-edge-2"}`}>
                    {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="border-t border-surface-2 px-4 py-4">
          <p id="productivity-colors-label" className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
            Productivity colors
          </p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="productivity-colors-label">
            {PRODUCTIVITY_OPTIONS.map((choice, index) => {
              const selected = (drafts.productivity_style ?? meta.settings.productivity_style ?? "vivid") === choice.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectSetting("productivity_style", choice.id)}
                  onKeyDown={(event) =>
                    handleRadioKey(
                      event,
                      PRODUCTIVITY_OPTIONS.map((option) => option.id),
                      index,
                      (value) => selectSetting("productivity_style", value),
                    )}
                  className={`flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 transition-colors ${selected ? "border-accent/70 bg-surface-3" : "border-edge bg-surface-2 hover:bg-surface-3"}`}
                >
                  <span className="flex gap-1" aria-hidden="true">
                    <span className="h-4 w-4 rounded" style={{ backgroundColor: themedChoice(choice).productive }} />
                    <span className="h-4 w-4 rounded" style={{ backgroundColor: themedChoice(choice).unproductive }} />
                  </span>
                  <span className="text-xs font-medium text-ink">{choice.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-snug text-ink-3">
            Colorblind uses blue and red to distinguish the states for common red–green color vision differences.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 border-t border-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-xs leading-snug text-ink-3">
            Existing categories keep their saved colors.
          </p>
          <button
            type="button"
            onClick={onManageCategories}
            className="shrink-0 text-xs font-medium text-ink-3 transition-colors hover:text-ink-2"
          >
            Open Categories &amp; Rules
          </button>
        </div>
      </Section>

      <Section
        title="Activity list"
        intro="Hide obscure system utilities and rarely seen items from the Activity list. This never changes totals or Insights, and categorized items always remain visible."
      >
        {/* Utilities are recognized by name alone, so this switch stands on its
            own and leads. The rare-item switch cannot be read without the two
            limits that define "rare", so those three travel together below. */}
        <Row
          label="Hide system utilities"
          help="Hides uncategorized installers, drivers, and temporary files."
          control={
            <PrivacyToggle
              label="Hide system utilities"
              enabled={hideUtilities}
              onChange={(enabled) => setNoiseVisibility(hideRare, enabled)}
            />
          }
        />
        <SettingGroup
          dependents={hideRare && (
            <>
              <Row
                bare
                compact
                label="Time limit"
                help="Less than this much recorded time, across all history."
                control={numberControl(SPECS.noiseTime, "Rare-item time limit", "min")}
              />
              <Row
                bare
                compact
                label="Session limit"
                help="…and no more than this many sessions."
                control={numberControl(SPECS.noiseSessions, "Rare-item session limit", "sessions")}
              />
            </>
          )}
        >
          <Row
            bare
            label="Hide rare items"
            help="Hides uncategorized items that fall under both of the limits below."
            control={
              <PrivacyToggle
                label="Hide rare items"
                enabled={hideRare}
                onChange={(enabled) => setNoiseVisibility(enabled, hideUtilities)}
              />
            }
          />
        </SettingGroup>
      </Section>

      <Section title="Advanced">
        <Row
          label="Minimum app time"
          help="Hides apps averaging less than this per tracked day from Insights' Top Apps."
          control={numberControl(SPECS.minimum, "Minimum app time", "min/day")}
        />
        <Row label="Heartbeat interval" help="How often the current session is saved; a crash can lose up to this much recent activity." control={numberControl(SPECS.heartbeat, "Heartbeat interval", "s")} />
        <Row
          stacked
          label="Browser processes"
          help="Processes treated as browsers for Website detection and Website or Window rules."
          control={
            <BrowserProcessEditor
              value={drafts.browser_processes ?? ""}
              onChange={saveBrowserProcesses}
            />
          }
        />
      </Section>

      <RestoreDefaultsSection
        disabled={savingKeys.size > 0}
        onRestored={() => setPause({ paused: false, until: 0 })}
      />
      <DataSection settingsBusy={savingKeys.size > 0} />
      </div>
      <SectionRail />
    </div>
  );
}

/** Privacy stays discoverable from Settings without Settings hosting the list:
 *  exclusions are per-entity curation, and that belongs with the other
 *  per-entity work in Activity. This row only ever says how many there are —
 *  a count is the one rendering that reads the same at three exclusions and at
 *  three hundred — and hands off to the list that can actually edit them. */
function ExclusionSummary({ onManage }: { onManage: () => void }) {
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
    <div className="flex flex-col items-start gap-2 border-t border-surface-2 px-4 py-[13px] sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="min-w-0 text-xs leading-snug text-ink-3">
        {total === 0
          ? "Nothing is excluded from tracking — mark an app or website “Do not track” in Activity."
          : `${parts.join(" and ")} are never tracked.`}
      </p>
      {total > 0 && (
        <button
          type="button"
          onClick={onManage}
          className="shrink-0 text-xs font-semibold text-accent transition-colors hover:text-accent/80"
        >
          View and manage
        </button>
      )}
    </div>
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
    <p className="mt-2 text-xs text-ink-3">
      Dashboard {appVersion ?? "—"} · Tracker {trackerVersion ?? "not stamped yet"}
    </p>
  );
}

function RestoreDefaultsSection({
  disabled,
  onRestored,
}: {
  disabled: boolean;
  onRestored: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const restore = async () => {
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
      setConfirming(false);
    } catch (error) {
      banner.report(error, "default settings");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Section title="Defaults">
      {confirming && (
        <ConfirmDialog
          title="Restore default settings?"
          body="Every setting on this page returns to its default, including recording and Windows startup, which will be turned off."
          note="Recorded history, categories, rules, aliases, exclusions, corrections, and backups are not touched."
          confirmLabel="Restore defaults"
          busyLabel="Restoring…"
          busy={restoring}
          // Not "danger": this resets preferences and destroys no data. The red
          // button is reserved for the ones that remove recorded activity.
          variant="default"
          onConfirm={() => void restore()}
          onClose={() => setConfirming(false)}
        />
      )}
      <Row
        label="Restore default settings"
        help="Resets every setting on this page without changing recorded history or organization."
        control={
          <button
            type="button"
            disabled={disabled || restoring}
            title={disabled ? "Wait for settings to finish saving" : undefined}
            onClick={() => setConfirming(true)}
            className="rounded-[8px] border border-edge px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:border-edge-2 hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            {restoring ? "Restoring…" : restored ? "Defaults restored" : "Restore defaults"}
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
function DataSection({ settingsBusy }: { settingsBusy: boolean }) {
  const meta = useMeta();
  const banner = useBanner();
  const [olderDays, setOlderDays] = useState("365");
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupDetail, setBackupDetail] = useState<{ ok: boolean; text: string } | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // The retention delete carries its own counted scope, so it is held as a
  // pending request rather than a bare open flag.
  const [pendingOlder, setPendingOlder] = useState<
    { days: number; cutoff: number; count: number; what: string } | null
  >(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<"older" | "erase" | null>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);

  const copyPath = () => void navigator.clipboard.writeText(getDbPath()).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });

  const backUpNow = async () => {
    if (backingUp) return;
    setBackingUp(true);
    setBackupDetail(null);
    try {
      const target = await backupDatabase();
      setBackupDetail({ ok: true, text: `Backup saved to ${target}` });
    } catch (error) {
      setBackupDetail({ ok: false, text: explainDbError(error, "backup") });
    } finally {
      setBackingUp(false);
    }
  };
  const closeRestore = () => {
    setRestoreOpen(false);
    requestAnimationFrame(() => restoreButtonRef.current?.focus());
  };

  // Counting before asking is the point of the dialog: a native confirm could
  // only ever say "older than 365 days", never how many sessions that is.
  const deleteOlder = async () => {
    const days = Math.floor(Number(olderDays));
    if (!Number.isFinite(days) || days < 1) {
      setOlderDays("365");
      return;
    }
    try {
      const cutoff = Date.now() / 1000 - days * 86_400;
      const count = await countSessionsOlderThan(cutoff);
      const what = `older than ${days} day${days === 1 ? "" : "s"}`;
      if (count === 0) {
        setMessage(`No recorded sessions ${what}.`);
        return;
      }
      setPendingOlder({ days, cutoff, count, what });
    } catch (e) {
      banner.report(e, "deletion");
    }
  };

  const runDeleteOlder = async () => {
    if (!pendingOlder) return;
    setBusyAction("older");
    try {
      await deleteHistoryBefore(pendingOlder.cutoff);
      setMessage(
        `Deleted ${pendingOlder.count} session${pendingOlder.count === 1 ? "" : "s"} ${pendingOlder.what}.`,
      );
      setPendingOlder(null);
      await meta.refresh();
    } catch (e) {
      banner.report(e, "deletion");
    } finally {
      setBusyAction(null);
    }
  };

  const eraseEverything = async () => {
    setBusyAction("erase");
    try {
      await updateSetting("recording_consent", "0");
      await updateSetting("launch_at_login", "0");
      await invoke("set_launch_at_login", { enabled: false });
      await invoke("stop_tracker");
      const n = await eraseAllHistory();
      setMessage(`Securely erased ${n} recorded session${n === 1 ? "" : "s"}. Separate backups were not deleted.`);
      setEraseOpen(false);
      await meta.refresh();
    } catch (e) {
      banner.report(e, "secure erase");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <SettingsSection title="Data management">
      <SectionLabel>Data management</SectionLabel>
      <div className="overflow-hidden rounded-[13px] border border-edge bg-surface-dim">
        <div className="p-4">
          <p className="mb-[9px] text-xs text-ink-3">Database path</p>
          <div className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 p-[9px] pl-[13px]">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={getDbPath()}>{getDbPath()}</span>
            <button
              type="button"
              className="rounded-[7px] border border-edge px-2.5 py-[5px] text-xs text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
              onClick={copyPath}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={backingUp}
              aria-busy={backingUp}
              onClick={() => void backUpNow()}
              className="flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-accent/30 bg-gradient-to-b from-accent/15 to-accent/[.08] py-[11px] text-xs font-semibold text-accent shadow-[inset_0_1px_0_rgba(255,255,255,.05)] transition-colors hover:from-accent/25 hover:to-accent/15 disabled:cursor-wait disabled:opacity-60"
            >
              {backingUp ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden="true" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3v11" /><path d="M7 9l5 5 5-5" /><path d="M4 20h16" />
                </svg>
              )}
              {backingUp ? "Backing up…" : "Back up now"}
            </button>
            <button
              ref={restoreButtonRef}
              type="button"
              disabled={settingsBusy}
              title={settingsBusy ? "Wait for settings to finish saving" : undefined}
              onClick={() => setRestoreOpen(true)}
              className="flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-edge bg-surface-2 py-[11px] text-xs font-semibold text-ink-2 transition-colors hover:border-edge-2 hover:bg-surface-3 hover:text-ink disabled:cursor-wait disabled:opacity-50"
            >
              Restore backup…
            </button>
          </div>
          {backupDetail && (
            <p
              className={`mt-2 break-all text-xs ${backupDetail.ok ? "text-ink-3" : "text-bad"}`}
              role={backupDetail.ok ? "status" : "alert"}
              aria-live={backupDetail.ok ? "polite" : "assertive"}
            >
              {backupDetail.text}
            </p>
          )}
          <p className="mt-3 text-xs leading-snug text-ink-3">
            Backups are stored in a Backups folder beside this database. Everything stays on your machine.
          </p>
          <VersionsLine trackerVersion={meta.settings.tracker_version} />
        </div>
        <Row
          label="Delete history older than"
          help="Removes everything recorded before the cutoff. Categories and rules are kept."
          control={
            <span className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={1}
                value={olderDays}
                aria-label="Days of history to keep"
                onChange={(event) => setOlderDays(event.target.value)}
                className="w-[64px] rounded-[9px] border border-control-edge bg-control px-[11px] py-2 text-right text-xs text-ink outline-none focus:border-accent/60"
              />
              <span className="text-xs text-ink-3">days</span>
              <TrashButton label="Delete older history" onClick={() => void deleteOlder()} />
            </span>
          }
        />
        <div className="flex flex-col items-start gap-2 border-t border-surface-2 bg-bad/[.03] px-4 py-[13px] sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-xs text-ink-3">Securely erase all recorded history</p>
          <button
            type="button"
            className="shrink-0 text-xs font-semibold text-bad transition-colors hover:text-bad/80"
            onClick={() => setEraseOpen(true)}
          >
            Erase all
          </button>
        </div>
        {message && <p className="border-t border-surface-2 px-4 py-3 text-xs text-ink-2">{message}</p>}
      </div>
      {restoreOpen && createPortal(
        <RestoreBackupDialog onClose={closeRestore} />,
        document.body,
      )}
      {pendingOlder && (
        <ConfirmDialog
          title="Delete recorded activity?"
          body={`Every session ${pendingOlder.what} will be removed.`}
          metrics={[{ label: "Sessions", value: String(pendingOlder.count) }]}
          note="Complete session rows are removed and securely compacted, and cannot be restored unless you have a backup. Categories and rules are kept."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          busy={busyAction === "older"}
          extraAction={
            <Button
              onClick={() => void backupDatabase()
                .then((target) => setBackupDetail({ ok: true, text: `Backup saved to ${target}` }))
                .catch((error) => setBackupDetail({ ok: false, text: explainDbError(error, "backup") }))}
            >
              Back up first
            </Button>
          }
          onConfirm={() => void runDeleteOlder()}
          onClose={() => setPendingOlder(null)}
        />
      )}
      {eraseOpen && (
        <ConfirmDialog
          title="Erase all recorded history?"
          body="Every recorded session is removed and the database is compacted. Recording and Windows startup are turned off, and the tracker is stopped."
          note="Categories, rules, and settings are kept, and separate backup files are not deleted. Nothing here can be recovered without one of those backups."
          confirmLabel="Erase everything"
          busyLabel="Erasing…"
          busy={busyAction === "erase"}
          // The typed gate the window.prompt used to impose, kept — this is the
          // highest-stakes action in the product — but now with the consequences
          // above the field instead of inside the sentence asking for the word.
          requireTyped="DELETE"
          onConfirm={() => void eraseEverything()}
          onClose={() => setEraseOpen(false)}
        />
      )}
    </SettingsSection>
  );
}

function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function backupPrimaryLabel(backup: DatabaseBackup): string {
  const kind = backup.kind === "Manual"
    ? "Manual backup"
    : backup.kind === "Before update"
      ? "Pre-update backup"
      : backup.kind === "Before restore"
        ? "Pre-restore backup"
        : "Backup";
  return `${kind} · ${new Date(backup.modifiedSec * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const banner = useBanner();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const selected = backups.find((backup) => backup.path === selectedPath) ?? null;

  useEffect(() => {
    void listDatabaseBackups()
      .then(setBackups)
      .catch((error: unknown) => setLoadError(explainDbError(error, "backups")))
      .finally(() => setLoading(false));
  }, []);
  useLayoutEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !restoring) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, restoring]);

  const chooseAnother = async () => {
    try {
      const path = await chooseDatabaseBackupFile();
      if (!path) return;
      const inspected = await inspectDatabaseBackup(path);
      setBackups((current) => [
        inspected,
        ...current.filter((backup) => backup.path !== inspected.path),
      ]);
      setSelectedPath(inspected.path);
    } catch (error) {
      banner.report(error, "backup file");
    }
  };
  const restore = async () => {
    if (!selected?.compatible) return;
    setRestoring(true);
    try {
      await restoreDatabase(selected.path);
    } catch (error) {
      banner.report(error, "database restore");
      setRestoring(false);
    }
  };
  const paths = backups.map((backup) => backup.path);

  return (
    <div className="settings-dialog fixed inset-0 z-[70] flex items-center justify-center bg-scrim p-2 sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-backup-title"
        aria-describedby="restore-backup-description"
        tabIndex={-1}
        onKeyDown={trapModalFocus}
        className="scroll-well max-h-[calc(100dvh-1rem)] w-full max-w-lg overflow-y-auto rounded-[14px] border border-edge-2 bg-surface p-4 shadow-panel outline-none sm:max-h-[calc(100dvh-2rem)] sm:p-5"
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 id="restore-backup-title" className="text-sm font-semibold text-ink">
              Restore backup
            </h2>
            <p id="restore-backup-description" className="mt-1 text-xs leading-relaxed text-ink-3">
              Choose a snapshot to replace history, categories, rules, and settings. Time creates a safety backup first, then restarts automatically.
            </p>
          </div>
          <button
            type="button"
            disabled={restoring}
            aria-label="Close restore backup dialog"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-ink-3 hover:bg-hover-2 hover:text-ink disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 max-h-[300px] overflow-y-auto rounded-[11px] border border-edge bg-surface-dim p-2">
          {loading && <p className="px-2 py-6 text-center text-xs text-ink-3">Finding backups…</p>}
          {loadError && <p className="px-2 py-4 text-xs text-bad">{loadError}</p>}
          {!loading && !loadError && backups.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-ink-3">
              No Time backups found yet.
            </p>
          )}
          {!loading && backups.length > 0 && (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Available backups">
              {backups.map((backup, index) => {
                const checked = selectedPath === backup.path;
                return (
                  <button
                    key={backup.path}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked || (selectedPath === null && index === 0) ? 0 : -1}
                    onClick={() => setSelectedPath(backup.path)}
                    onKeyDown={(event) => handleRadioKey(event, paths, index, setSelectedPath)}
                    className={`rounded-[9px] border px-3 py-2.5 text-left transition-colors ${
                      checked
                        ? "border-accent/60 bg-accent/[.08]"
                        : "border-transparent hover:border-edge hover:bg-surface-2"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                        {backupPrimaryLabel(backup)}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-ink-3" title={backup.path}>
                      {backup.name} · {formatBackupSize(backup.bytes)}
                      {backup.schemaVersion !== null && ` · Schema ${backup.schemaVersion}`}
                      {backup.legacyLocation && " · Legacy location"}
                    </span>
                    {backup.issue && (
                      <span className="mt-1 block text-xs leading-snug text-bad">
                        {backup.issue}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          disabled={restoring}
          onClick={() => void chooseAnother()}
          className="mt-3 text-xs font-semibold text-accent hover:text-accent/80 disabled:opacity-40"
        >
          Choose another file…
        </button>

        <div className="mt-4 rounded-[10px] border border-bad/25 bg-bad/[.035] px-3 py-2.5 text-xs leading-relaxed text-ink-3">
          Activity recorded after the selected backup will no longer appear. The automatic safety backup lets you restore the current state again if needed.
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={restoring}
            onClick={onClose}
            className="rounded-[8px] border border-edge px-3 py-1.5 text-xs font-semibold text-ink-2 hover:border-edge-2 hover:text-ink disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected?.compatible || restoring}
            onClick={() => void restore()}
            className="rounded-[8px] border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {restoring ? "Restoring…" : "Restore and restart"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * On is a *filled* control, not a tinted one, and its knob is whatever reads on
 * that fill — which is what --color-on-accent means. Off drops the knob to a
 * muted ink so it recedes.
 *
 * The translucent accent this replaces put the same near-full-strength ink knob
 * on both states, so off claimed as much attention as on, and the two differed
 * only by the knob's position. It also went wrong in light: an accent at 35%
 * over white is pale, so the ink knob landed at 10.5:1 against it where the
 * dark theme's sat at 7.2:1 — the light knob was the heavier of the two, on the
 * theme with less contrast to spend. Anchoring the pair to the accent fill makes
 * both themes land together without either being tuned by hand.
 */
function PrivacyToggle({
  label,
  enabled,
  disabled = false,
  onChange,
}: {
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className="relative h-9 w-11 rounded-full disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1.5 h-6 w-11 rounded-full border transition-colors ${
          enabled ? "border-accent bg-accent" : "border-edge-2 bg-surface-2"
        }`}
      />
      <span
        aria-hidden="true"
        className={`absolute top-[10px] h-4 w-4 rounded-full transition-all ${
          enabled ? "left-[22px] bg-on-accent" : "left-[3px] bg-ink-3"
        }`}
      />
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-3 pl-0.5 text-micro font-bold uppercase tracking-[.09em] text-ink-2">{children}</p>;
}

/** `intro` carries the rationale a whole section shares, so its rows can keep
 *  the one-sentence helps that make the column read evenly. */
function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <SettingsSection title={title}>
      <SectionLabel>{title}</SectionLabel>
      <div className="overflow-hidden rounded-[13px] border border-edge bg-surface-dim">
        {intro && <p className="px-4 pb-3 pt-4 text-xs leading-snug text-ink-3">{intro}</p>}
        {children}
      </div>
    </SettingsSection>
  );
}

/** Every section the rail can reach, in page order. The rail is built from this
 *  list and each section takes its anchor from the same slug, so a section that
 *  is added, renamed or reordered cannot end up missing from the rail or
 *  pointing at nothing — the failure a hand-written list of links invites. */
const SETTINGS_SECTIONS = [
  "Tracker status",
  "Recording & startup",
  "Goals",
  "Timeline window",
  "Focus & idle",
  "Appearance",
  "Activity list",
  "Advanced",
  "Defaults",
  "Data management",
] as const;

/** How far into the viewport a section has to reach before the rail calls it the
 *  current one. Roughly one section label plus its gap. */
const ACTIVE_SECTION_BAND = 88;

function sectionSlug(title: string): string {
  return `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** A section wrapper that carries its own anchor. `scroll-mt` clears the height
 *  the label would otherwise be jammed against at the top of the viewport. */
function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section id={sectionSlug(title)} className="scroll-mt-4">
      {children}
    </section>
  );
}

/**
 * Settings is ten sections in one column, and the column was correct — any
 * masonry layout re-balances every time a section changes height. The problem
 * was never width, it was length: there is no way to see what is on the page
 * without scrolling all of it.
 *
 * So the rail says what is here and jumps to it, and it lives in the dead space
 * beside a 600px column rather than taking any width from it. It appears only at
 * the app's "large" layout class and above (lib/responsive.ts), because that is
 * where the space exists — below it the page is exactly as it was.
 *
 * It sits to the *right* of the column. On the left it read as a second-level
 * tab bar competing with the real one directly above it, and it pushed the
 * settings themselves off the left margin every other tab starts at. On the
 * right it is unmistakably an index of the column beside it, and the column
 * stays where the rest of the app's content does.
 */
function SectionRail() {
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0]);

  useEffect(() => {
    const sections: { title: string; node: HTMLElement }[] = [];
    for (const title of SETTINGS_SECTIONS) {
      const node = document.getElementById(sectionSlug(title));
      if (node) sections.push({ title, node });
    }
    if (sections.length === 0) return;
    const viewport = sections[0].node.closest<HTMLElement>(".app-viewport") ?? null;

    // The last section that has started, not the first one still touching the
    // viewport. An IntersectionObserver picking the topmost intersecting section
    // marks the one being *left*: a card's last row is still on screen while its
    // successor fills the rest of it, which is the reading position.
    const measure = () => {
      // At the end of the scroll the rule above cannot reach the last sections:
      // nothing below the final screenful can be brought to the top of the
      // viewport, so their tops never cross the band and the mark would stick a
      // few sections early. At the bottom, the last section is where you are.
      if (viewport && viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 2) {
        setActive(sections[sections.length - 1].title);
        return;
      }
      const band = (viewport?.getBoundingClientRect().top ?? 0) + ACTIVE_SECTION_BAND;
      let current = sections[0].title;
      for (const { title, node } of sections) {
        if (node.getBoundingClientRect().top <= band) current = title;
        else break;
      }
      setActive(current);
    };

    measure();
    const target: HTMLElement | Window = viewport ?? window;
    target.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // Sections change height as settings expand (the rare-item limits appear and
    // disappear), which moves every section below them without any scrolling.
    const observer = new ResizeObserver(measure);
    for (const { node } of sections) observer.observe(node);
    return () => {
      target.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-2 hidden w-[150px] shrink-0 flex-col gap-px self-start min-[1008px]:flex"
    >
      {SETTINGS_SECTIONS.map((title) => (
        <a
          key={title}
          href={`#${sectionSlug(title)}`}
          aria-current={active === title ? "true" : undefined}
          className={`truncate rounded-md px-2 py-[5px] text-xs transition-colors ${
            active === title
              ? "bg-surface-2 font-medium text-ink"
              : "text-ink-3 hover:bg-hover hover:text-ink-2"
          }`}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}

/** A setting plus the settings that only qualify it. A rail and an indent say
 *  "these belong to that" and nothing else: a tinted panel read as an
 *  unexplained color change, and any heading over it just repeated the label of
 *  the switch it contained. The row keeps the card's normal rhythm, so the
 *  group costs the column no extra structure when the dependents are hidden. */
function SettingGroup({ children, dependents }: { children: ReactNode; dependents?: ReactNode }) {
  return (
    <div className="border-t border-surface-2 px-4 py-[15px]">
      {children}
      {dependents && (
        <div className="ml-[3px] mt-4 flex flex-col gap-[15px] border-l border-edge-2 pl-[18px]">
          {dependents}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  help,
  control,
  bare = false,
  compact = false,
  stacked = false,
}: {
  label: string;
  help: string;
  control: ReactNode;
  /** Drop the card chrome — the caller is already providing it. */
  bare?: boolean;
  /** One step down in weight, for a row that qualifies the one above it. */
  compact?: boolean;
  /** Places a wide control below its description instead of in the right rail. */
  stacked?: boolean;
}) {
  return (
    <div
      className={`${stacked ? "" : "flex items-center justify-between gap-4 max-sm:block"} ${
        bare ? "" : "border-t border-surface-2 px-4 py-[15px] first:border-t-0"
      }`}
    >
      <div className="min-w-0">
        <p className={`font-medium text-ink ${compact ? "text-xs" : "text-row"}`}>{label}</p>
        <p className="mt-[5px] max-w-[400px] text-meta leading-snug text-ink-3">
          {help}
        </p>
      </div>
      <div className={stacked ? "mt-3" : "shrink-0 max-sm:mt-3"}>{control}</div>
    </div>
  );
}

function BrowserProcessEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (processes: string[]) => void;
}) {
  const processes = normalizeBrowserProcesses(value);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const instructionsId = "browser-process-instructions";

  const commit = (raw = input) => {
    const additions = normalizeBrowserProcesses(raw);
    if (additions.length > 0) {
      const next = [...processes];
      for (const process of additions) {
        if (!next.includes(process)) next.push(process);
      }
      if (next.length !== processes.length) onChange(next);
    }
    setInput("");
  };

  const remove = (index: number) => {
    if (processes.length <= 1) return;
    onChange(processes.filter((_, processIndex) => processIndex !== index));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const focusChip = (index: number) => {
    chipRefs.current[index]?.focus();
  };

  return (
    <div
      className="flex min-h-[42px] flex-wrap items-center gap-2 rounded-[10px] border border-control-edge bg-control px-2.5 py-2 transition-colors focus-within:border-accent/60"
      role="group"
      aria-label="Browser processes"
      aria-describedby={instructionsId}
    >
      {processes.map((process, index) => {
        const label = process.replace(/\.exe$/i, "");
        const removable = processes.length > 1;
        return (
          <button
            key={process}
            ref={(element) => {
              chipRefs.current[index] = element;
            }}
            type="button"
            tabIndex={-1}
            aria-label={
              removable
                ? `Remove ${label} from browser processes`
                : `${label}; at least one browser process is required`
            }
            aria-disabled={!removable}
            title={removable ? `Remove ${label}` : "At least one browser process is required"}
            onClick={() => remove(index)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                focusChip(Math.max(0, index - 1));
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                if (index === processes.length - 1) inputRef.current?.focus();
                else focusChip(index + 1);
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                remove(index);
              } else if (event.key === "Escape") {
                event.preventDefault();
                inputRef.current?.focus();
              }
            }}
            className={`flex h-7 items-center gap-1.5 rounded-[8px] border border-edge bg-surface-3 px-2.5 font-mono text-xs text-ink transition-colors ${
              removable ? "hover:border-edge-2 hover:bg-hover-2" : "cursor-default"
            }`}
          >
            <span>{label}</span>
            <span aria-hidden="true" className={removable ? "text-ink-3" : "text-ink-3/40"}>×</span>
          </button>
        );
      })}
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={input}
        aria-label="Add a browser process"
        placeholder="Add a browser process…"
        onChange={(event) => setInput(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (input.trim() || !/[\r\n,]/.test(pasted)) return;
          event.preventDefault();
          commit(pasted);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (
            event.key === "ArrowLeft"
            && input.length === 0
            && event.currentTarget.selectionStart === 0
            && processes.length > 0
          ) {
            event.preventDefault();
            focusChip(processes.length - 1);
          }
        }}
        className="h-7 min-w-0 flex-1 basis-full bg-transparent px-1 font-mono text-xs text-ink outline-none placeholder:font-sans placeholder:text-ink-3 sm:min-w-[168px] sm:basis-auto"
      />
      <span id={instructionsId} className="sr-only">
        Press Enter or comma to add. From the empty input, press Left Arrow to manage existing processes, then Delete to remove one.
      </span>
    </div>
  );
}

function NumberStepper({
  label,
  value,
  display,
  unit,
  readOnly = false,
  onChange,
  onBlur,
  onMinus,
  onPlus,
}: {
  label: string;
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
    <div className="inline-flex items-center rounded-[10px] border border-control-edge bg-control p-[3px] transition-colors focus-within:border-accent/60">
      <button type="button" aria-label={`Decrease ${label}`} className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-sm text-ink-2 hover:bg-hover-2 hover:text-ink" onClick={onMinus}>−</button>
      <div className={`flex items-baseline justify-center ${display ? "w-[46px]" : unit ? "min-w-[34px] gap-1" : "min-w-[34px]"}`}>
        <input
          type={readOnly ? "text" : "number"}
          readOnly={readOnly}
          aria-label={label}
          value={display ?? value}
          style={unit ? { width: `${Math.max((display ?? value).length, 1)}ch` } : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className={`${unit ? "text-right" : "w-full text-center"} bg-transparent text-row font-semibold tabular-nums text-ink outline-none`}
        />
        {unit && <span className="text-xs text-ink-3">{unit}</span>}
      </div>
      <button type="button" aria-label={`Increase ${label}`} className="flex h-7 w-[30px] items-center justify-center rounded-[7px] text-sm text-ink-2 hover:bg-hover-2 hover:text-ink" onClick={onPlus}>+</button>
    </div>
  );
}

function Segmented({ label, options, value, onChange, labels }: { label: string; options: string[]; value: string; onChange: (value: string) => void; labels?: Record<string, string> }) {
  return (
    <div className="inline-flex rounded-[10px] border border-edge bg-surface-2 p-[3px]" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          type="button"
          key={option}
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          className={`rounded-[7px] px-[13px] py-1.5 text-xs transition-colors ${value === option ? "bg-accent/15 font-semibold text-accent" : "text-ink-3 hover:text-ink-2"}`}
          onClick={() => onChange(option)}
          onKeyDown={(event) => handleRadioKey(event, options, index, onChange)}
        >
          {labels?.[option] ?? (option === "auto" ? "Auto" : option)}
        </button>
      ))}
    </div>
  );
}
