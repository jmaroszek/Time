import { useCallback, useEffect, useRef, useState } from "react";

import { Spinner } from "../components/ui";
import { ExtensionLinks } from "../components/ExtensionLinks";
import { displayBrowserProcesses, normalizeBrowserProcesses } from "../lib/browsers";
import { fmtElapsed } from "../lib/format";
import { KeyedSerialQueue } from "../lib/keyedSerialQueue";
import { normalizeMediaSites } from "../lib/mediaSites";
import {
  hidesRareItems,
  hidesUtilities,
  noiseModeFor,
} from "../lib/noise";
import {
  paletteForTheme,
  PALETTES,
  paletteStrip,
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
  runTrackingLifecycle,
  updateSetting,
  type TrackerStatus,
} from "../lib/queries";
import {
  clockHour,
  displayValue,
  resolvedNoiseMode,
  settingDraftValue,
  SPECS,
  type NumericSpec,
} from "../lib/settingsSpecs";
import { useBanner } from "../state/banner";
import { useLifecycleBusy } from "../lib/lifecycleBusy";
import { useMeta } from "../state/meta";
import DataSection from "./settings/DataSection";
import ExclusionSummary from "./settings/ExclusionSummary";
import HelpAndFeedbackSection from "./settings/HelpAndFeedbackSection";
import RestoreDefaultsSection from "./settings/RestoreDefaultsSection";
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
  TextAction,
  handleRadioKey,
  sanitizeNumericDraft,
} from "./settings/fields";

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

function trackerHeartbeatIsLive(status: TrackerStatus): boolean {
  return status.lastHeartbeat !== null
    && status.lastHeartbeat > 0
    && Date.now() / 1000 - status.lastHeartbeat < TRACKER_LIVE_STALE_SECONDS;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SaveOutcome = "idle" | "saved" | "failed";

// Pending writes outlive the tab. A fresh mount must join the same queue so
// older selections cannot commit after the user's latest choice.
const settingWrites = new KeyedSerialQueue();

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
    const operation = settingWrites.run(key, () =>
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
            : `No tracker heartbeat for ${fmtElapsed(heartbeatAge)}`;
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
  const selectedPalette = PALETTES.find(
    (palette) => palette.id === (drafts.color_palette ?? meta.palette.id),
  ) ?? meta.palette;

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
              <TextAction
                disabled={resumingTracker || lifecycleBusy}
                onClick={() => void resumeTracking()}
              >
                {resumingTracker ? "Resuming…" : "Resume now"}
              </TextAction>
            </div>
          ) : !trackingEnabled || trackerLive ? (
            heartbeatAge !== null && (
              <span className="basis-full text-xs tabular-nums text-ink-3 sm:ml-auto sm:basis-auto">
                last heartbeat {fmtElapsed(heartbeatAge)} ago
              </span>
            )
          ) : (
            <div className="basis-full sm:ml-auto sm:basis-auto">
              <TextAction
                disabled={startingTracker || lifecycleBusy}
                onClick={() => void startTracker()}
              >
                {startingTracker ? "Starting…" : "Start tracker"}
              </TextAction>
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
          help="Check for updates when you open Time."
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
          help="Splits browser time by website. Requires the Time Web Extension."
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
        {/* The switch reports the stored preference; this full-width footer
            reports the exceptional case where Windows holds no startup entry. */}
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
            </span>
          }
          footer={trackingEnabled
            && meta.settings.launch_at_login === "1"
            && startupRegistered === false ? (
            <span className="block text-xs text-bad">
              Windows has no startup entry for Time, and it could not be added
              automatically.{" "}
              <button
                type="button"
                className="underline underline-offset-2 disabled:opacity-50"
                disabled={lifecycleBusy || savingKeys.has("launch_at_login")}
                onClick={() => void setStartAtLogin(true)}
              >
                Try again
              </button>
            </span>
          ) : undefined}
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
          label="Record on a schedule"
          help="Record only during selected hours."
          control={
            <PrivacyToggle
              label="Record on a schedule"
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
              help="Video or audio playing on these sites keeps you from being marked AFK. Major streaming and music sites are built in."
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
            help="No keyboard or mouse input for this long marks you AFK. Software-generated input doesn’t count. AFK time does not count towards your totals."
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
        <Row label="Day starts at" help="First hour shown in the Timeline and Rhythm visualizations. Activity before still counts towards your totals." control={numberControl(SPECS.start, "Day starts at", undefined, true)} />
        <Row label="Day ends at" help="Last hour shown in the Timeline and Rhythm visualizations. Activity after still counts towards your totals." control={numberControl(SPECS.end, "Day ends at", undefined, true)} />
      </Section>

      {/* Every way to hide something, in one place. The minimum-app-time rate
          used to sit under "Insights" and these two switches under "Activity
          list", which filed one question — stop showing me noise — under two
          headings by which tab it happened to affect. Which rows appear is
          still a question about the data, so this sits above Appearance, the
          one section that changes nothing but how the app looks. */}
      <Section
        title="Hidden items"
        intro="Keeps low-signal items out of your lists. Filtered items still count towards totals."
      >
        {/* The stored key is still min_app_seconds_per_day: it was app-only
            before Insights ranked websites, and renaming a settings key costs a
            migration to buy nothing the label cannot say. */}
        <Row
          label="Minimum daily time"
          help="Hides apps and websites averaging less than this per tracked day from the Insights panel."
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

      {/* Five palettes as one row of tiles rather than five stacked cards. The
          cards drew fifty saturated squares down the middle of the page, and —
          hue-sorted — made every palette look like the same row repeated. A
          tile carries only what the choice needs: the colors new categories
          receive, in that order, and the name. The selected palette's
          description is said once, under the row. */}
      <Section title="Appearance">
        <Row
          label="Theme"
          help="Follow system matches your operating system's theme."
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
        <div className="border-t border-surface-2 px-4 py-4">
          <p id="category-palette-label" className="mb-3 text-row font-medium text-ink">
            Category palette
          </p>
          <div
            className="grid grid-cols-5 gap-2 max-sm:grid-cols-3"
            role="radiogroup"
            aria-labelledby="category-palette-label"
          >
            {PALETTES.map((option, index) => {
              const selected = selectedPalette.id === option.id;
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
                  className={`flex min-w-0 flex-col gap-2 rounded-[10px] border p-2.5 text-left transition-colors ${
                    selected
                      ? "border-accent/70 bg-selected-strong"
                      : "border-card-edge bg-raised hover:bg-selected-strong"
                  }`}
                >
                  <span className="flex h-2.5 overflow-hidden rounded-full" aria-hidden="true">
                    {paletteStrip(paletteForTheme(option, meta.theme)).map((swatch) => (
                      <span key={swatch} className="flex-1" style={{ backgroundColor: swatch }} />
                    ))}
                  </span>
                  <span className="truncate text-xs font-semibold text-ink">{option.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2.5 text-meta leading-snug text-ink-3">{selectedPalette.description}</p>
        </div>
        <Row
          label="Productivity colors"
          help="Colorblind swaps green for blue."
          control={
            <Segmented
              label="Productivity colors"
              options={PRODUCTIVITY_OPTIONS.map((choice) => choice.id)}
              labels={Object.fromEntries(PRODUCTIVITY_OPTIONS.map((choice) => [
                choice.id,
                <>
                  <span className="flex gap-[3px]" aria-hidden="true">
                    <span className="h-[9px] w-[9px] rounded-[3px]" style={{ backgroundColor: themedChoice(choice).productive }} />
                    <span className="h-[9px] w-[9px] rounded-[3px]" style={{ backgroundColor: themedChoice(choice).unproductive }} />
                  </span>
                  {choice.label}
                </>,
              ]))}
              value={drafts.productivity_style ?? meta.settings.productivity_style ?? "vivid"}
              onChange={(value) => selectSetting("productivity_style", value)}
            />
          }
        />
        <div className="flex flex-col items-start gap-2 border-t border-surface-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-meta leading-snug text-ink-3">
            Existing categories keep their saved colors.
          </p>
          <TextAction onClick={onManageCategories}>Open Categories &amp; Rules</TextAction>
        </div>
      </Section>

      <Section title="Advanced">
        <Row
          stacked
          label="Browser processes"
          help="Programs Time treats as web browsers."
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
      <HelpAndFeedbackSection
        appVersion={appVersion}
        trackerVersion={meta.settings.tracker_version}
      />
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
