// Whether the tracker is doing what the reader has asked of it.
//
// Two axes, deliberately separate. The heartbeat answers "is the process
// alive"; the settings answer "is recording supposed to be happening". The
// tracker stamps its health unconditionally, before any recording gate is
// applied, so a paused or descheduled tracker is a *live* process that is
// recording nothing. Collapsing the two axes into one boolean is what let the
// welcome panel tell a paused reader that Time was recording in the background.
//
// Two thresholds, deliberately far apart. The tracker stamps health every 5s
// (HEALTH_HEARTBEAT_SECONDS in tracker/tracker.py), so a Settings dot that a
// reader is actively looking at can afford to call anything past 8s "not
// detected" — they are watching it, and a stale dot that corrects itself a
// second later costs nothing.
//
// A warning that follows the reader onto every tab cannot be that twitchy. It
// interrupts, so it has to be right, and one missed stamp is not evidence of
// anything. TRACKER_ALERT_STALE_SECONDS is twenty-four intervals: long enough
// that a machine waking from sleep or a busy moment cannot trip it, short enough
// that a tracker which died after a reboot is reported the next time Time is
// opened rather than a day later.
//
// Do not confuse the health stamp with the `heartbeat_seconds` setting. That one
// defaults to 15s and governs how often an open session is flushed to disk
// (session_manager.py); it is a persistence cadence, and neither threshold here
// measures it.

import { trackingScheduleState } from "./trackingSchedule";

/** "Live right now", for a status dot under the reader's eye. */
export const TRACKER_LIVE_STALE_SECONDS = 8;

/** "Something is wrong", for a warning that follows the reader. */
export const TRACKER_ALERT_STALE_SECONDS = 120;

/**
 * How long after the dashboard opens a silent tracker is still just booting.
 *
 * The two processes start together — the installer launches the dashboard, which
 * launches the tracker, and Windows sign-in starts them side by side — and the
 * dashboard wins that race every time. It is a webview with a database already
 * on disk; the tracker is a PyInstaller bundle that has to unpack itself, import
 * its world, and build a tray icon before it reaches the loop that stamps
 * health. So the first status read of a perfectly healthy launch says "no
 * heartbeat", and reporting that verbatim greeted every fresh install with the
 * one banner reserved for a broken tracker, cleared a second or two later.
 *
 * Eight seconds is above what that boot takes even on a slow machine — a VM with
 * Defender scanning a newly written executable — and far below the point where a
 * reader would rather have been told sooner. Nothing is claimed during the wait:
 * the state is `unconfirmed` and every banner stays silent, because the honest
 * answer to "is it recording" is not yet known. Guessing "yes" would be the
 * cheaper fix and the wrong one — this is a tracker, and it does not get to
 * imply that recording is happening on no evidence.
 */
export const TRACKER_LAUNCH_GRACE_SECONDS = 8;

/** Settings keys that permanently retire a notice the reader has read. Written
 *  on demand and read as `!== "1"`, so they need no bootstrap default — and
 *  deliberately outside DEFAULT_USER_SETTINGS, because restoring default
 *  settings should not resurrect notices the reader already dealt with. */
export const WELCOME_DISMISSED_KEY = "welcome_dismissed";
export const RECORDING_OFF_DISMISSED_KEY = "recording_off_notice_dismissed";
export const OFF_SCHEDULE_DISMISSED_KEY = "off_schedule_notice_dismissed";

/** How much history a reader may have and still be shown welcome copy.
 *
 *  The panel cannot be gated on an empty database: that was the original gate,
 *  and the first arriving session destroyed the panel within a minute, before a
 *  new reader had finished reading it. Age of the *first* session is stable
 *  under that arrival and still expires on its own, so a reader who ignored the
 *  panel for a year stops being greeted as new. */
export const WELCOME_MAX_HISTORY_DAYS = 7;

/**
 * What is happening to recording right now, and whether the reader asked for it.
 *
 * Exactly one of these is true at a time, which is what keeps two surfaces from
 * reporting the same fact in different words.
 */
export type RecordingState =
  /** Consent never given, nothing ever recorded. The true first run. */
  | { kind: "never_started" }
  /** Consent withdrawn by a reader who already has history. Their decision. */
  | { kind: "consent_withdrawn" }
  /** A start has been issued and the tracker has not confirmed it yet. */
  | { kind: "starting" }
  /** The dashboard has only just opened and the tracker has not answered yet —
   *  too early to call it either way. See TRACKER_LAUNCH_GRACE_SECONDS. */
  | { kind: "unconfirmed" }
  /** Running and recording. */
  | { kind: "recording" }
  /** Paused from the tray or the dashboard. `until` is null when indefinite. */
  | { kind: "paused"; until: number | null }
  /** Outside the configured recording schedule. */
  | { kind: "off_schedule"; nextStart: Date | null; valid: boolean }
  /** Recording was expected and the tracker is not answering. The one alarm. */
  | { kind: "stopped" };

export interface RecordingStateInput {
  /** Seconds since the tracker last stamped health; null when it never has. */
  heartbeatAgeSec: number | null;
  settings: Record<string, string>;
  nowSec: number;
  /** Sessions recorded ever. Separates a true first run from a deliberate stop. */
  totalSessionCount?: number;
  /** True while the reader's own start is still unconfirmed, so the moments
   *  after pressing the button are not reported as a dead tracker. */
  starting?: boolean;
  /** True while the dashboard is still inside its launch grace, so a tracker
   *  that has not answered yet is reported as unconfirmed rather than stopped.
   *  Surfaces the reader is watching on purpose — the Settings dot — leave this
   *  off: they asked for the current answer and a correction costs them
   *  nothing. See TRACKER_LAUNCH_GRACE_SECONDS. */
  launchGrace?: boolean;
}

/** Kept as its own type because `trackerNeedsAttention` predates the state
 *  model and its callers pass exactly these three fields. */
export type TrackerAlertInput = RecordingStateInput;

/**
 * Resolve the one true recording state.
 *
 * Order matters. Every silence with a reason the reader already knows about is
 * resolved before liveness is consulted, and that is the whole point: a warning
 * that also fires for a deliberate pause teaches people to ignore it, which
 * costs exactly the one case it exists for. It also means a tracker that died
 * while paused still reports the pause the reader chose rather than an alarm
 * about a process they had already told to stop working.
 */
export function recordingState(
  {
    heartbeatAgeSec,
    settings,
    nowSec,
    totalSessionCount = 0,
    starting = false,
    launchGrace = false,
  }: RecordingStateInput,
  staleAfterSec: number = TRACKER_ALERT_STALE_SECONDS,
): RecordingState {
  if (settings.recording_consent !== "1") {
    return totalSessionCount > 0 ? { kind: "consent_withdrawn" } : { kind: "never_started" };
  }
  const pausedUntil = Number(settings.tracking_paused_until) || 0;
  if (settings.tracking_paused === "1" || pausedUntil > nowSec) {
    return { kind: "paused", until: pausedUntil > nowSec ? pausedUntil : null };
  }
  const schedule = trackingScheduleState(settings, new Date(nowSec * 1000));
  if (schedule.enabled && !schedule.recordingAllowed) {
    return { kind: "off_schedule", nextStart: schedule.nextStart, valid: schedule.valid };
  }
  // Null means the tracker has never checked in, or checked out cleanly: the
  // shutdown path zeroes the stamp on purpose. Either way it is the strongest
  // version of this signal and not a reason to stay quiet — once there has been
  // time for an answer.
  if (heartbeatAgeSec !== null && heartbeatAgeSec < staleAfterSec) return { kind: "recording" };
  if (starting) return { kind: "starting" };
  // A start the reader asked for outranks this: it names who is waiting and
  // carries its own escalation. What is left is a silence nobody asked about,
  // which is only worth reporting once the tracker has had time to speak.
  //
  // Not gated on a null stamp, though null is the common case — a clean shutdown
  // zeroes it on purpose. A crash, a kill from Task Manager, or a machine cut
  // mid-session leaves the last stamp at whatever age it reached, and at launch
  // that number describes the *previous* run: it cannot distinguish a tracker
  // that died from one that started moments ago and has not stamped yet. Same
  // ambiguity, same grace.
  if (launchGrace) return { kind: "unconfirmed" };
  return { kind: "stopped" };
}

/**
 * True when recording is supposed to be happening and is not.
 *
 * The alarm predicate, preserved as its own name because it is the contract the
 * interrupting banner is built on. It is now one reading of `recordingState`.
 */
export function trackerNeedsAttention(
  input: TrackerAlertInput,
  staleAfterSec: number = TRACKER_ALERT_STALE_SECONDS,
): boolean {
  return recordingState(input, staleAfterSec).kind === "stopped";
}

/** Whether this reader is new enough to be shown welcome copy. */
export function readerIsNew(firstSessionSec: number | null, nowSec: number): boolean {
  if (firstSessionSec === null) return true;
  return nowSec - firstSessionSec < WELCOME_MAX_HISTORY_DAYS * 86_400;
}

export type BannerId =
  | "welcome"
  | "start_recording"
  | "recording_off"
  | "paused"
  | "off_schedule"
  | "stopped";

export interface BannerPlan {
  id: BannerId;
  /** "insights" is the landing tab only; "all" is every tab but Settings, which
   *  reports the same fact in its own status panel. */
  scope: "insights" | "all";
  dismissible: boolean;
  /** The settings key that retires it for good, or null when dismissal lasts
   *  only for this pause episode. */
  dismissKey: string | null;
}

export interface BannerContext {
  /** Reader is new enough for welcome copy — see WELCOME_MAX_HISTORY_DAYS. */
  readerIsNew: boolean;
  settings: Record<string, string>;
  /** Pause notices are dismissed per episode rather than for good, so a later
   *  pause announces itself once more. Held by the caller, not in settings. */
  pauseNoticeDismissed: boolean;
}

/**
 * The one banner this state earns, or null for silence.
 *
 * Returning a single plan is deliberate. Two surfaces reporting one fact used to
 * be prevented by hand-maintained suppression conditions at each call site; with
 * one state resolving to at most one banner it cannot happen by construction.
 *
 * Only `stopped` and the true first run are undismissable. Everything else is
 * either a state the reader chose — and can therefore be told to stop saying —
 * or a welcome they have finished reading.
 */
export function bannerFor(state: RecordingState, context: BannerContext): BannerPlan | null {
  const dismissed = (key: string) => context.settings[key] === "1";
  switch (state.kind) {
    case "never_started":
      // No dismiss control: after "Not now" on the privacy screen this panel is
      // the readiest way to start recording, and the only one outside Settings.
      return { id: "start_recording", scope: "insights", dismissible: false, dismissKey: null };
    case "starting":
      // Keep the first-run panel mounted through the unconfirmed window so its
      // own escalation has somewhere to appear. An established reader who just
      // switched recording back on gets silence instead: the health stamp lands
      // within seconds, and greeting them with a welcome panel for those seconds
      // is worse than saying nothing. If the start really failed, this state
      // expires into `stopped` and the alarm covers it.
      if (!context.readerIsNew) return null;
      return { id: "start_recording", scope: "insights", dismissible: false, dismissKey: null };
    case "unconfirmed":
      // Silence, deliberately, and for every reader. Nothing is known yet, so
      // there is nothing any banner here could say that would still be true a
      // second later — including the welcome copy, which asserts that recording
      // is under way. The state expires into `recording` or `stopped` within
      // TRACKER_LAUNCH_GRACE_SECONDS and whichever arrives gets its banner then.
      return null;
    case "consent_withdrawn":
      if (dismissed(RECORDING_OFF_DISMISSED_KEY)) return null;
      return {
        id: "recording_off",
        scope: "insights",
        dismissible: true,
        dismissKey: RECORDING_OFF_DISMISSED_KEY,
      };
    case "recording":
      if (!context.readerIsNew || dismissed(WELCOME_DISMISSED_KEY)) return null;
      return {
        id: "welcome",
        scope: "insights",
        dismissible: true,
        dismissKey: WELCOME_DISMISSED_KEY,
      };
    case "paused":
      if (context.pauseNoticeDismissed) return null;
      // Every tab: a reader looking at Activity is misled by a paused tracker
      // exactly as much as one looking at Insights.
      return { id: "paused", scope: "all", dismissible: true, dismissKey: null };
    case "off_schedule":
      if (dismissed(OFF_SCHEDULE_DISMISSED_KEY)) return null;
      return {
        id: "off_schedule",
        scope: "insights",
        dismissible: true,
        dismissKey: OFF_SCHEDULE_DISMISSED_KEY,
      };
    case "stopped":
      return { id: "stopped", scope: "all", dismissible: false, dismissKey: null };
  }
}

/** Whether a plan should render on the tab the reader is looking at. */
export function bannerVisibleOnTab(plan: BannerPlan | null, tab: string): boolean {
  if (plan === null || tab === "settings") return false;
  return plan.scope === "all" || tab === "insights";
}
