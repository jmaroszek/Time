import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button, ConfirmDialog, Spinner } from "../components/ui";
import { ExtensionLinks } from "../components/ExtensionLinks";
import { displayBrowserProcesses, normalizeBrowserProcesses } from "../lib/browsers";
import { fmtDuration } from "../lib/format";
import { KeyedSerialQueue } from "../lib/keyedSerialQueue";
import { normalizeMediaSites } from "../lib/mediaSites";
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
  DEFAULT_TRACKING_SCHEDULE_DAYS,
  DEFAULT_TRACKING_SCHEDULE_END_MINUTE,
  DEFAULT_TRACKING_SCHEDULE_START_MINUTE,
  formatScheduleResume,
  parseTrackingScheduleDays,
  scheduleInputToMinute,
  scheduleMinuteToInput,
  trackingScheduleState,
} from "../lib/trackingSchedule";
import { recordingState, TRACKER_LIVE_STALE_SECONDS } from "../lib/trackerHealth";
import {
  fetchSettings,
  fetchStartupIsRegistered,
  fetchTrackerStatus,
  listTrackingExclusions,
  restoreDefaultSettings,
  runTrackingLifecycle,
  updateSetting,
  type TrackerStatus,
} from "../lib/queries";
import { SUPPORT_EMAIL, supportEmailUrl } from "../lib/support";
import { useBanner } from "../state/banner";
import { useLifecycleBusy } from "../state/lifecycleBusy";
import { useMeta } from "../state/meta";
import DataSection from "./settings/DataSection";
import {
  FlashedSection,
  SECTION_FLASH_MS,
  SECTION_SCROLL_DELAY_MS,
  Section,
  SectionLabel,
  SectionRail,
  SettingsSection,
  sectionSlug,
} from "./settings/chrome";
import {
  BrowserProcessEditor,
  MediaSiteEditor,
  NumberStepper,
  PrivacyToggle,
  Row,
  ScheduleTimeInput,
  Segmented,
  SettingGroup,
  handleRadioKey,
  sanitizeNumericDraft,
} from "./settings/fields";

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

const TRACKER_STATUS_POLL_MS = 2_000;
const TRACKER_START_TIMEOUT_MS = 10_000;
const TRACKING_SCHEDULE_DAYS = [
  { value: 0, short: "M", label: "Monday" },
  { value: 1, short: "T", label: "Tuesday" },
  { value: 2, short: "W", label: "Wednesday" },
  { value: 3, short: "T", label: "Thursday" },
  { value: 4, short: "F", label: "Friday" },
  { value: 5, short: "S", label: "Saturday" },
  { value: 6, short: "S", label: "Sunday" },
] as const;

// A century comfortably exceeds any real retention need and keeps the cutoff
// computation (days * 86_400 seconds) far from anything that could misbehave.
function trackerHeartbeatIsLive(status: TrackerStatus): boolean {
  return status.lastHeartbeat !== null
    && status.lastHeartbeat > 0
    && Date.now() / 1000 - status.lastHeartbeat < TRACKER_LIVE_STALE_SECONDS;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayValue(spec: NumericSpec, raw: string | undefined): string {
  const value = Number(raw);
  return Number.isFinite(value) ? String(Math.round((value / spec.scale) * 100) / 100) : "";
}

/** Strips a numeric draft down to what a number field could ever mean here —
 *  digits, and (only where the spec steps in fractions) a single decimal
 *  point. Every spec's minimum is non-negative, so a minus sign is never
 *  valid; scientific notation isn't either. Runs on every keystroke and
 *  paste, ahead of the min/max clamp saveNumeric applies on blur. */
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

/** Split rather than one formatted string, so the hour renders in the same
 *  bright weight as every other stepper's value and "am"/"pm" renders in the
 *  same muted weight as every other stepper's unit — matching "20 hrs" and
 *  "3 min" instead of standing out as the one all-bright value in the section. */
function clockHour(value: number): { hour: string; meridiem: "am" | "pm" } {
  const normalized = value % 24;
  return { hour: String(normalized % 12 || 12), meridiem: normalized < 12 ? "am" : "pm" };
}

function resolvedNoiseMode(raw: string | undefined): NoiseMode {
  return raw === "off"
    || raw === "one_off"
    || raw === "utilities_only"
    || raw === "utilities"
    ? raw
    : "utilities";
}


type SaveOutcome = "idle" | "saved" | "failed";


export default function SettingsTab({
  onManageExclusions,
  onManageCategories,
  highlightSection = null,
  onHighlightShown,
}: {
  onManageExclusions: () => void;
  onManageCategories: () => void;
  /** A section title to scroll to and mark on arrival — a one-shot request from
   *  whatever sent the reader here, cleared through onHighlightShown. */
  highlightSection?: string | null;
  onHighlightShown?: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const [startingTracker, setStartingTracker] = useState(false);
  const [resumingTracker, setResumingTracker] = useState(false);
  const lifecycleBusy = useLifecycleBusy();
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [flashedSection, setFlashedSection] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome>("idle");
  const writeQueueRef = useRef(new KeyedSerialQueue());
  const writeSequenceRef = useRef(0);
  const latestWriteRef = useRef(new Map<string, number>());
  const optimisticDraftsRef = useRef(new Map<string, string>());
  const immediateActionsRef = useRef(new Set<string>());
  const saveOutcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);

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

  // The timer is held in a ref rather than cleared by this effect's teardown:
  // onHighlightShown clears the request that triggered it, which re-runs the
  // effect immediately — a teardown-owned timer would cancel the mark before
  // anyone saw it.
  useEffect(() => {
    if (!highlightSection) return;
    const slug = sectionSlug(highlightSection);
    setFlashedSection(highlightSection);
    onHighlightShown?.();
    // Instant, and after the tab has settled. This effect runs in the commit
    // that mounts Settings; scrolling from there does not survive, because the
    // panel is still being built around it — under StrictMode it is mounted
    // twice, and the viewport's scrollTop clamps back to zero while the
    // content it was scrolled over is briefly gone. A smooth scroll fares
    // worse still: the charts sizing themselves cancel it outright.
    const scroll = setTimeout(() => {
      document.getElementById(slug)?.scrollIntoView({ block: "start" });
    }, SECTION_SCROLL_DELAY_MS);
    scrollTimerRef.current = scroll;
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashedSection(null), SECTION_FLASH_MS);
  }, [highlightSection, onHighlightShown]);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, []);

  // Whether Windows actually holds the startup registration. `null` means the
  // question could not be asked, which is not the same as "no" and must not be
  // reported as one — the switch below stays quiet unless the answer is a
  // definite no.
  //
  // Read on the settings that decide what the registration should be, rather
  // than on a timer. Nothing changes it while this tab is open except the
  // actions on this tab, and each of those refreshes `meta` on the way out.
  const [startupRegistered, setStartupRegistered] = useState<boolean | null>(null);
  const refreshStartupRegistration = useCallback(() => {
    void fetchStartupIsRegistered()
      .then(setStartupRegistered)
      .catch(() => setStartupRegistered(null));
  }, []);
  // Settings changing is not enough on its own. Repairing a lost registration
  // writes the registry without changing `launch_at_login`, which already said
  // on — so the actions below call this directly. Keyed on the settings too, for
  // the paths that reach registration by changing one of them.
  useEffect(refreshStartupRegistration, [
    refreshStartupRegistration,
    meta.settings.launch_at_login,
    meta.settings.recording_consent,
  ]);

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
    const pendingDraft = optimisticDraftsRef.current.get(key);
    if (
      pendingDraft === draftValue
      || (pendingDraft === undefined && storedValue === (meta.settings[key] ?? ""))
    ) {
      setDrafts((current) => ({ ...current, [key]: draftValue }));
      return;
    }
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
    queueSetting("browser_processes", storedValue, draftValue);
  };
  const saveMediaDomains = (sites: string[]) => {
    // Empty is a valid state here, unlike the browser list: it means Time's
    // built-in media sites are the whole set, which is the default.
    const storedValue = normalizeMediaSites(sites.join(",")).join(",");
    queueSetting("media_domains", storedValue, storedValue);
  };
  const selectSetting = (key: string, value: string) => {
    queueSetting(key, value);
  };

  const heartbeatAge = status?.lastHeartbeat == null || status.lastHeartbeat <= 0
    ? null
    : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < TRACKER_LIVE_STALE_SECONDS;
  const trackingEnabled = meta.settings.recording_consent === "1";
  // The draft wins so the warning clears the moment the switch is turned off,
  // rather than waiting for the tracker's next poll to agree.
  const trayIconRequested =
    (drafts.show_tray_icon ?? meta.settings.show_tray_icon ?? "1") !== "0";
  const scheduleSettings = { ...meta.settings, ...drafts };
  const schedule = trackingScheduleState(scheduleSettings);
  const selectedScheduleDays = parseTrackingScheduleDays(
    scheduleSettings.tracking_schedule_days ?? DEFAULT_TRACKING_SCHEDULE_DAYS,
  );
  const scheduleEnabled = schedule.enabled;
  // The same state the banners read, so this panel and they cannot disagree —
  // at this tab's tighter liveness threshold, because the reader is watching the
  // dot. Pause comes from the poll above rather than meta, since the tray writes
  // it; drafts stay in so the schedule preview follows the reader's edits.
  const trackerRecording = recordingState({
    heartbeatAgeSec: heartbeatAge,
    settings: {
      ...scheduleSettings,
      tracking_paused: pause.paused ? "1" : "0",
      tracking_paused_until: String(pause.until),
    },
    nowSec: Date.now() / 1000,
    totalSessionCount: status?.totalSessionCount ?? 0,
  }, TRACKER_LIVE_STALE_SECONDS);
  const trackerOff = trackerRecording.kind === "never_started"
    || trackerRecording.kind === "consent_withdrawn";
  // Precedence follows recordingState: a silence the reader chose outranks the
  // liveness of a process they had already told to stop recording. The Start
  // button below stays keyed on liveness, so a tracker that died during a pause
  // still offers recovery under the label naming the pause.
  const trackerLabel = trackerOff
    ? "Tracking disabled"
    : trackerRecording.kind === "paused"
      ? "Tracking paused"
      : trackerRecording.kind === "off_schedule"
        ? "Outside scheduled hours"
        : trackerRecording.kind === "recording"
          ? "Tracker is live"
          : "Tracker not detected";
  const trackerDetail = trackerOff
    ? "No new activity is being recorded"
    : trackerRecording.kind === "paused"
      ? trackerRecording.until !== null
        ? `Resumes at ${new Date(trackerRecording.until * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, or now from here or the tray`
        : "Nothing is being recorded until you resume"
      : trackerRecording.kind === "off_schedule"
        ? !trackerRecording.valid
          ? "Choose at least one day and different start and end times"
          : trackerRecording.nextStart
            ? `Scheduled to resume ${formatScheduleResume(trackerRecording.nextStart)}`
            : "No recording days are selected"
        : trackerRecording.kind === "recording"
          ? "Collecting activity in real time"
          : heartbeatAge === null
            ? "Waiting for a tracker health signal"
            : `No tracker heartbeat for ${fmtDuration(Math.max(heartbeatAge, 0))}`;
  const trackerDot = trackerOff
    ? "bg-ink-3"
    : trackerRecording.kind === "paused" || trackerRecording.kind === "off_schedule"
      ? "bg-warn"
      : trackerRecording.kind === "recording"
        ? "live-pulse bg-good-data"
        : "alert-pulse bg-bad";
  const noiseMode = resolvedNoiseMode(drafts.activity_noise_filter);
  const hideRare = hidesRareItems(noiseMode);
  const hideUtilities = hidesUtilities(noiseMode);
  const setNoiseVisibility = (rare: boolean, utilities: boolean) =>
    selectSetting("activity_noise_filter", noiseModeFor(rare, utilities));

  const setTrackingEnabled = async (enabled: boolean) => {
    await runImmediateSettingAction("recording_consent", async () => {
      await runTrackingLifecycle({ action: "set_recording", enabled });
    }, "tracking preference");
    // Turning recording on can register startup when a schedule is on, and
    // turning it off always unregisters.
    refreshStartupRegistration();
  };

  const setStartAtLogin = async (enabled: boolean) => {
    await runImmediateSettingAction("launch_at_login", async () => {
      await runTrackingLifecycle({ action: "set_startup", enabled });
    }, "startup preference");
    // Re-ask Windows rather than assuming. Enabling on a database that already
    // said on changes no setting, so nothing else here would notice that the
    // registration is now present — which is exactly the repair case.
    refreshStartupRegistration();
  };

  const scheduleValues = (overrides: Partial<{
    days: string;
    startMinute: number;
    endMinute: number;
  }> = {}) => {
    const selected = parseTrackingScheduleDays(
      drafts.tracking_schedule_days
        ?? meta.settings.tracking_schedule_days
        ?? DEFAULT_TRACKING_SCHEDULE_DAYS,
    );
    const startMinute = Number(
      drafts.tracking_schedule_start_minute
        ?? meta.settings.tracking_schedule_start_minute,
    );
    const endMinute = Number(
      drafts.tracking_schedule_end_minute
        ?? meta.settings.tracking_schedule_end_minute,
    );
    return {
      days: overrides.days ?? selected.sort((a, b) => a - b).join(","),
      startMinute: overrides.startMinute ?? (
        Number.isFinite(startMinute) ? startMinute : DEFAULT_TRACKING_SCHEDULE_START_MINUTE
      ),
      endMinute: overrides.endMinute ?? (
        Number.isFinite(endMinute) ? endMinute : DEFAULT_TRACKING_SCHEDULE_END_MINUTE
      ),
    };
  };
  const saveSchedule = (
    key: string,
    enabled: boolean,
    values: ReturnType<typeof scheduleValues>,
  ) => {
    void runImmediateSettingAction(key, async () => {
      await runTrackingLifecycle({ action: "set_schedule", enabled, ...values });
    }, "tracking schedule").then(refreshStartupRegistration);
    // Enabling a schedule registers startup as a side effect, so the report
    // below it has to be re-asked rather than inferred from the schedule key.
  };

  const setScheduleEnabled = async (enabled: boolean) => {
    saveSchedule("tracking_schedule_enabled", enabled, scheduleValues());
  };

  const toggleScheduleDay = (day: number) => {
    const selected = new Set(parseTrackingScheduleDays(
      drafts.tracking_schedule_days ?? meta.settings.tracking_schedule_days ?? DEFAULT_TRACKING_SCHEDULE_DAYS,
    ));
    if (selected.has(day)) {
      if (selected.size === 1) return;
      selected.delete(day);
    } else {
      selected.add(day);
    }
    saveSchedule(
      "tracking_schedule_days",
      scheduleEnabled,
      scheduleValues({ days: [...selected].sort((a, b) => a - b).join(",") }),
    );
  };

  const setScheduleTime = (key: string, value: string) => {
    const minute = scheduleInputToMinute(value);
    if (minute === null) return;
    saveSchedule(
      key,
      scheduleEnabled,
      scheduleValues(
        key === "tracking_schedule_start_minute"
          ? { startMinute: minute }
          : { endMinute: minute },
      ),
    );
  };

  // Starting is not resuming. The lifecycle action clears both pause keys and
  // starts the process under one native mutex, so a paused tracker cannot be
  // launched into a second state that keeps recording disabled.
  const resumeTracking = async () => {
    if (resumingTracker || lifecycleBusy) return;
    setResumingTracker(true);
    try {
      await runTrackingLifecycle({ action: "resume" });
      // The pause poll runs on its own 15s cycle; without this the panel would
      // keep reporting the pause the reader has just ended.
      setPause({ paused: false, until: 0 });
      await meta.refresh();
      banner.show("Tracking resumed");
    } catch (error) {
      banner.report(error, "resuming tracking");
    } finally {
      setResumingTracker(false);
    }
  };

  const startTracker = async () => {
    if (startingTracker || lifecycleBusy) return;
    setStartingTracker(true);
    try {
      await runTrackingLifecycle({ action: "ensure_started" });
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

  const numberControl = (spec: NumericSpec, label: string, unit?: string, hour = false) => {
    const clock = hour ? clockHour(Number(drafts[spec.key]) || 0) : null;
    return (
    <NumberStepper
      label={label}
      value={drafts[spec.key] ?? ""}
      display={clock?.hour}
      unit={clock?.meridiem ?? unit}
      readOnly={hour}
      min={spec.min}
      max={spec.max}
      step={spec.step ?? 1}
      onChange={(value) =>
        setDrafts((current) => ({
          ...current,
          [spec.key]: sanitizeNumericDraft(value, !Number.isInteger(spec.step ?? 1)),
        }))
      }
      onBlur={() => void saveNumeric(spec)}
      onMinus={() => step(spec, -1)}
      onPlus={() => step(spec, 1)}
    />
    );
  };

  return (
    // One column of settings, not two. Any masonry layout re-balances whenever a
    // section changes height, so a second column would make the page look uneven
    // again the next time a setting is added. Length is the only thing that grows
    // here — which is what the rail beside it addresses, without taking width
    // from the column or reflowing it.
    <FlashedSection.Provider value={flashedSection}>
    <div className="settings-panel mr-auto flex w-full max-w-[774px] gap-9 pt-2">
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
        <div className="flex flex-wrap items-center gap-3 rounded-[13px] border border-card-edge bg-surface-dim px-4 py-4 sm:px-[18px]">
          <span className={`h-[9px] w-[9px] rounded-full ${trackerDot}`} />
          <div className="min-w-0">
            <p className="text-row font-semibold text-ink">
              {trackerLabel}
            </p>
            <p className="mt-[3px] text-xs text-ink-3">
              {trackerDetail}
            </p>
          </div>
          {trackerRecording.kind === "paused" ? (
            <div className="basis-full sm:ml-auto sm:basis-auto">
              <Button
                variant="primary"
                disabled={resumingTracker || lifecycleBusy}
                onClick={() => void resumeTracking()}
              >
                {resumingTracker ? "Resuming…" : "Resume now"}
              </Button>
            </div>
          ) : !trackingEnabled || trackerLive ? (
            heartbeatAge !== null && (
              <span className="basis-full text-xs tabular-nums text-ink-3 sm:ml-auto sm:basis-auto">
                last heartbeat {fmtDuration(Math.max(heartbeatAge, 0))} ago
              </span>
            )
          ) : (
            <div className="basis-full sm:ml-auto sm:basis-auto">
              <Button
                variant="primary"
                disabled={startingTracker || lifecycleBusy}
                onClick={() => void startTracker()}
              >
                {startingTracker ? "Starting…" : "Start tracker"}
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Consent, what gets kept, and the one request that leaves this machine.
          Those are the questions a tracker owes a straight answer to, so they
          lead and they sit together — including the update check, which is not
          an "advanced" detail but the only time Time touches the network.
          When the tracker runs is a separate question, and moved below. */}
      <Section title="Privacy & recording">
        <Row
          label="Record activity"
          help="Allows the tracker to record app names and times."
          control={<PrivacyToggle label="Record activity" enabled={trackingEnabled} disabled={lifecycleBusy || savingKeys.has("recording_consent") || savingKeys.has("launch_at_login")} onChange={(enabled) => void setTrackingEnabled(enabled)} />}
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
        {/* The only network request Time makes. Installing stays a separate,
            manual act: the control for it appears beside the tabs when a
            version is waiting. */}
        <Row
          label="Check for updates"
          help="Check for updates once per day. Time will not install a new version without your consent."
          control={
            <PrivacyToggle
              label="Check for updates"
              enabled={
                (drafts.check_updates_automatically
                  ?? meta.settings.check_updates_automatically
                  ?? "1") !== "0"
              }
              disabled={savingKeys.has("check_updates_automatically")}
              onChange={(enabled) =>
                selectSetting("check_updates_automatically", enabled ? "1" : "0")
              }
            />
          }
        />
        {/* The switch and the install link, in one row, because a reader looking
            for one goes to the other.

            They were two rows for a defensible reason: the extension decides
            whether a site can reach Time at all, this decides whether Time keeps
            it, and the second is a lighter and more reversible act than
            uninstalling the first. That distinction is true and it did not
            survive contact with the page. Both rows said "website", sat
            adjacent, and the heading that names the feature — "Website
            detection" — owned only the links. Time's own author went looking for
            the recording switch underneath it, did not find it, and reported it
            missing. Anyone hunting for a website setting reads that heading
            first, so the setting has to be there.

            One row, then, titled for what the reader can decide, with the store
            links under the switch: install it, then choose whether Time keeps
            what it sends. The distinction the two rows were drawing lives in the
            help text, which is where a nuance that fine belongs. */}
        <Row
          label="Record websites"
          help="Stores the site a browser was on, so browser time splits by website. Turning this off records browser time without saying where it went. Needs Time Web Extension, below."
          control={
            <PrivacyToggle
              label="Record websites"
              enabled={
                (drafts.record_browser_domains
                  ?? meta.settings.record_browser_domains
                  ?? "1") !== "0"
              }
              onChange={(enabled) =>
                selectSetting("record_browser_domains", enabled ? "1" : "0")
              }
            />
          }
          footer={<ExtensionLinks />}
        />
        <ExclusionSummary onManage={onManageExclusions} />
      </Section>

      {/* Sign-in and the schedule share a section because they are one
          decision wearing two switches: scheduling holds launch-at-login on,
          and the row says so. Separating them would put a dependency and the
          hint that explains it in different cards. */}
      <Section title="Startup & schedule">
        <Row
          label="Start at Windows sign-in"
          help="Start the tracker when you sign into this Windows account."
          control={
            /* The hint is wider than the switch, and this column is only as
               wide as its widest child — so aligning to the start left-shifted
               the switch out of line with every other row's. Align to the end
               instead, where the rail of switches actually is, and back to the
               start on the narrow layout where the row stacks and the switches
               sit left. */
            <span className="inline-flex flex-col items-end gap-1 max-sm:items-start">
              <PrivacyToggle
                label="Start at Windows sign-in"
                enabled={meta.settings.launch_at_login === "1"}
                disabled={lifecycleBusy || !trackingEnabled || scheduleEnabled || savingKeys.has("recording_consent") || savingKeys.has("launch_at_login")}
                onChange={(enabled) => void setStartAtLogin(enabled)}
              />
              {!trackingEnabled && (
                <span className="text-xs text-ink-3 text-right max-sm:text-left">
                  Enable Record activity first
                </span>
              )}
              {trackingEnabled && scheduleEnabled && (
                <span className="text-xs text-ink-3 text-right max-sm:text-left">
                  Required while scheduling is on
                </span>
              )}
              {/* The switch above reports the stored setting, which is what was
                  asked for. This reports what Windows actually holds. They are
                  reconciled at every launch, so this appears only when that
                  repair could not be made — and it is the one state where the
                  switch alone is untrue: on, over nothing, with the tracker
                  simply not appearing at the next sign-in and no other symptom
                  until days of recording are missing. */}
              {trackingEnabled
                && meta.settings.launch_at_login === "1"
                && startupRegistered === false && (
                <span className="text-xs text-bad text-right max-sm:text-left">
                  Windows has no startup entry for Time, and it could not be
                  added automatically.{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 disabled:opacity-50"
                    disabled={lifecycleBusy || savingKeys.has("launch_at_login")}
                    onClick={() => void setStartAtLogin(true)}
                  >
                    Try again
                  </button>
                </span>
              )}
            </span>
          }
        />
        <Row
          label="Show tray icon"
          help="Show tracker icon, status, and controls in the Windows system tray."
          control={
            <span className="inline-flex flex-col items-end gap-1 max-sm:items-start">
              <PrivacyToggle
                label="Show tray icon"
                enabled={(drafts.show_tray_icon ?? meta.settings.show_tray_icon ?? "1") !== "0"}
                disabled={savingKeys.has("show_tray_icon")}
                onChange={(enabled) => selectSetting("show_tray_icon", enabled ? "1" : "0")}
              />
              {/* Asked for versus happened, the same split as start at sign-in
                  above. The tracker publishes whether an icon is genuinely up;
                  it cannot be created on a machine whose bundle is missing the
                  optional UI packages, and the switch alone would go on
                  promising a tray that is not there. Gated on a live heartbeat
                  because a stopped tracker leaves its last answer behind. */}
              {trayIconRequested && trackerLive && status?.trayActive === false && (
                <span className="text-xs text-bad text-right max-sm:text-left">
                  The tracker could not create a tray icon on this system.
                </span>
              )}
            </span>
          }
        />
        <Row
          label="Only record on a schedule"
          help="Keep the tracker running, but record only during the selected local work hours."
          control={
            <PrivacyToggle
              label="Only record on a schedule"
              enabled={scheduleEnabled}
              disabled={lifecycleBusy || !trackingEnabled || savingKeys.has("tracking_schedule_enabled")}
              onChange={(enabled) => void setScheduleEnabled(enabled)}
            />
          }
        />
        {scheduleEnabled && (
          <div className="border-t border-surface-2 px-4 py-4">
            <div className="flex flex-wrap gap-1.5" aria-label="Scheduled recording days">
              {TRACKING_SCHEDULE_DAYS.map((day) => {
                const selected = selectedScheduleDays.includes(day.value);
                return (
                  <button
                    key={day.label}
                    type="button"
                    disabled={lifecycleBusy}
                    aria-label={day.label}
                    aria-pressed={selected}
                    onClick={() => toggleScheduleDay(day.value)}
                    className={`h-8 min-w-8 rounded-[8px] border px-2 text-xs font-semibold transition-colors ${
                      selected
                        ? "border-accent bg-accent text-on-accent"
                        : "border-edge-2 bg-surface-2 text-ink-3 hover:text-ink"
                    }`}
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <ScheduleTimeInput
                label="From"
                value={scheduleMinuteToInput(
                  drafts.tracking_schedule_start_minute ?? meta.settings.tracking_schedule_start_minute,
                  DEFAULT_TRACKING_SCHEDULE_START_MINUTE,
                )}
                onChange={(value) => setScheduleTime("tracking_schedule_start_minute", value)}
                disabled={lifecycleBusy}
              />
              <ScheduleTimeInput
                label="Until"
                value={scheduleMinuteToInput(
                  drafts.tracking_schedule_end_minute ?? meta.settings.tracking_schedule_end_minute,
                  DEFAULT_TRACKING_SCHEDULE_END_MINUTE,
                )}
                onChange={(value) => setScheduleTime("tracking_schedule_end_minute", value)}
                disabled={lifecycleBusy}
              />
              <p className={`pb-2 text-xs ${schedule.valid ? "text-ink-3" : "text-bad"}`}>
                {!schedule.valid
                  ? selectedScheduleDays.length === 0
                    ? "Select at least one day."
                    : "Start and end must differ."
                  : Number(scheduleSettings.tracking_schedule_start_minute) > Number(scheduleSettings.tracking_schedule_end_minute)
                    ? "Runs overnight into the next day."
                    : "Uses this computer’s local time."}
              </p>
            </div>
          </div>
        )}
      </Section>

      {/* Directly under what gets recorded, because these two numbers
          decide what the recording *means*: the chain gap decides where one
          stretch of focus ends, and the idle threshold draws the line between
          computer use and time away from it. Every section below reads or draws
          the totals they define.

          Idle goes second, against the section title's order, because its media
          exception hangs off it in an indented group — and an indent that is
          not the last thing in the card leaves the row below it looking like it
          might be inside the group too. */}
      <Section title="Focus & idle">
        <Row label="Focus chain max gap" help="Bridges untracked gaps up to this long between productive sessions. Neutral and uncategorized activity preserve the chain without adding to its duration, while unproductive or AFK time ends it immediately." control={numberControl(SPECS.focus, "Focus chain max gap", "min")} />
        <SettingGroup
          dependents={
            <Row
              bare
              compact
              stacked
              label="Media sites"
              help="Video or audio playing on these sites keeps you from being marked AFK. Time already recognizes the major streaming and music services — add any it misses. Apps need no entry here."
              control={
                <MediaSiteEditor
                  value={drafts.media_domains ?? ""}
                  onChange={saveMediaDomains}
                />
              }
            />
          }
        >
          <Row
            bare
            label="AFK idle threshold"
            help="No input for this long marks you Away From Keyboard (AFK). AFK time is not classified and does not count towards computer use."
            control={numberControl(SPECS.idle, "AFK idle threshold", "min")}
          />
        </SettingGroup>
      </Section>

      {/* One section, not the two this was — "Insights" and "Timeline window"
          were named for the tabs they touch rather than the question they
          answer, which is how "Week starts on" ended up filed under a window it
          has nothing to do with while pacing the goal two sections above it.
          Read together they are the frame the numbers are measured in: the
          week everything else is measured against, the target paced against
          it, and the hours drawn. */}
      <Section title="Goals & time">
        <Row
          label="Week starts on"
          help="Affects weekly presets, bucketing, and goal pacing."
          control={<Segmented label="Week starts on" options={["Sunday", "Monday"]} value={drafts.week_start === "auto" ? meta.weekStart : (drafts.week_start ?? meta.weekStart)} onChange={(value) => selectSetting("week_start", value)} />}
        />
        <Row label="Weekly productivity goal" help="Set to 0 hours to leave your goal unset." control={numberControl(SPECS.goal, "Weekly productivity goal", "hrs")} />
        <Row label="Day starts at" help="First hour shown in Timeline and Rhythm. Activity outside this window still counts toward totals." control={numberControl(SPECS.start, "Day starts at", undefined, true)} />
        <Row label="Day ends at" help="Last hour shown in Timeline and Rhythm. Activity outside this window still counts toward totals." control={numberControl(SPECS.end, "Day ends at", undefined, true)} />
      </Section>

      {/* Every way to hide something, in one place. The minimum-app-time rate
          used to sit under "Insights" and these two switches under "Activity
          list", which filed one question — stop showing me noise — under two
          headings by which tab it happened to affect. Which rows appear is
          still a question about the data, so this sits above Appearance, the
          one section that changes nothing but how the app looks. */}
      <Section
        title="Hidden items"
        intro="Keep low-signal items out of the lists you read. Nothing here changes a total — the time is still recorded and still counted — and categorized items always remain visible."
      >
        {/* The stored key is still min_app_seconds_per_day: it was app-only
            before Insights ranked websites, and renaming a settings key costs a
            migration to buy nothing the label cannot say. */}
        <Row
          label="Minimum daily time"
          help="Hides apps and websites averaging less than this per tracked day from the Insights panel that ranks them. Whichever list is on screen reports how many rows it held back."
          control={numberControl(SPECS.minimum, "Minimum daily time", "min")}
        />
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
                control={numberControl(SPECS.noiseSessions, "Rare-item session limit")}
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

      <Section
        title="Appearance"
        intro="The app's theme, and the category and productivity colors used across every chart. Switching palettes changes the swatches offered for new categories, but does not change their existing colors."
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
                  className={`flex items-center gap-3 rounded-[11px] border px-3 py-2.5 text-left transition-colors ${selected ? "border-accent/70 bg-selected-strong" : "border-card-edge bg-raised hover:bg-selected-strong"}`}
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
                  className={`flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 transition-colors ${selected ? "border-accent/70 bg-selected-strong" : "border-card-edge bg-raised hover:bg-selected-strong"}`}
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

      <Section title="Advanced">
        <Row label="Heartbeat interval" help="How often data is saved to the database." control={numberControl(SPECS.heartbeat, "Heartbeat interval", "s")} />
        <Row
          stacked
          label="Browser processes"
          help="Processes treated as browsers for Record websites and Website or Window rules."
          control={
            <BrowserProcessEditor
              value={drafts.browser_processes ?? ""}
              onChange={saveBrowserProcesses}
            />
          }
        />
        <p className="border-t border-surface-2 px-4 py-3 text-xs text-ink-3">
          Dashboard {appVersion ?? "—"} · Tracker {meta.settings.tracker_version ?? "not stamped yet"}
        </p>
      </Section>

      {/* Restoring defaults and erasing history are the same kind of act, so
          they end the page together rather than with support wedged between
          them. Data goes last: it is the only section that can destroy
          something no setting can put back. */}
      <HelpAndFeedbackSection appVersion={appVersion} trackerVersion={meta.settings.tracker_version} />
      <RestoreDefaultsSection
        disabled={savingKeys.size > 0 || lifecycleBusy}
        onRestored={() => setPause({ paused: false, until: 0 })}
      />
      <DataSection
        settingsBusy={savingKeys.size > 0}
      />
      </div>
      <SectionRail />
    </div>
    </FlashedSection.Provider>
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

/** The app versions that make a report actionable travel with the email
 *  itself rather than sitting in this section — the one place they're worth
 *  reading on their own is beside the update control in Privacy & recording,
 *  which already reports what's installed. */
function HelpAndFeedbackSection({
  appVersion,
  trackerVersion,
}: {
  appVersion: string | null;
  trackerVersion: string | undefined;
}) {
  const banner = useBanner();
  const [copied, setCopied] = useState(false);

  const emailSupport = async () => {
    try {
      await openUrl(supportEmailUrl({ dashboardVersion: appVersion, trackerVersion }));
    } catch (error) {
      banner.report(error, "opening an email to Time support");
    }
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      banner.report(error, "copying the Time support address");
    }
  };

  return (
    <Section title="Help & feedback">
      <div className="flex flex-col items-start gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="max-w-[420px] text-meta leading-snug text-ink-3">
          Questions, bugs, or ideas? Email{" "}
          <span className="font-medium text-ink">{SUPPORT_EMAIL}</span>. Clicking
          “Email support” opens your email client and helps you draft a message. If
          that doesn't work, hit “Copy address” and send one the way you
          normally do.
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="primary" onClick={() => void emailSupport()}>
            Email support
          </Button>
          <Button onClick={() => void copyAddress()}>
            {copied ? "Copied" : "Copy address"}
          </Button>
        </div>
      </div>
    </Section>
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
    if (disabled || restoring) return;
    setRestoring(true);
    setRestored(false);
    try {
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
          confirmDisabled={disabled}
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
