// When Time may ask the reader for something, and which thing it asks for.
//
// Separate from trackerHealth's banner arbiter on purpose. That one resolves
// what is happening to *recording*, and a request for a favour is not a
// recording state; folding it in would corrupt a type whose whole contract is
// "what is the tracker doing". It is also strictly subordinate: App renders a
// prompt from here only when `bannerFor` returned null, so a reader whose
// tracker has stopped is never asked to go and praise it. At most one
// interruption remains on screen, which is the invariant that mattered.
//
// The gates below are a conjunction rather than a timer. A day count alone
// cannot tell thirty days of use from two sessions and a month of silence, and
// the reader in the second case has nothing to say. Everything here asks the
// same question the domain-coverage hint asks: has this message been earned
// yet, and is it true.

import {
  isPublished,
  type PublishedTimeExtensionListing,
  type TimeExtensionListing,
} from "./browserExtensions";

/** History age before an ask is even considered. Three weeks is where a reader
 *  has watched Time through enough of their own routine to have an opinion. */
export const FEEDBACK_MIN_HISTORY_DAYS = 21;

/** Distinct recorded days required alongside that age. This is the gate the
 *  calendar cannot supply: an install that has been sitting for a month with
 *  four days of sessions in it has not been used, whatever its age says. */
export const FEEDBACK_MIN_ACTIVE_DAYS = 10;

/** How long after the floor an ask waits for a milestone before giving up and
 *  asking anyway. A reader whose backlog is never empty would otherwise never
 *  be asked at all, which is the failure mode of milestone-only triggers. */
export const FEEDBACK_MILESTONE_FALLBACK_DAYS = 45;

/** Minimum spacing between two different asks. The app question and the
 *  extension question are about different products, but they arrive from the
 *  same application and read as one voice asking twice. */
export const FEEDBACK_PROMPT_GAP_DAYS = 45;

/** How long "Not now" holds an ask off. Short enough to still catch the reader
 *  while they use Time, long enough that it is not the same week. */
export const FEEDBACK_SNOOZE_DAYS = 14;

/** Absent reads as enabled, matching `check_updates_automatically`: the
 *  dashboard can open a database before the tracker has backfilled a newly
 *  added default, and an unwritten row must not be read as an opt-out. */
export const FEEDBACK_PROMPTS_ENABLED_KEY = "feedback_prompts_enabled";

/** Per-ask state. Deliberately outside DEFAULT_USER_SETTINGS, like the notice
 *  dismissals in trackerHealth: restoring default settings must not resurrect
 *  an ask the reader has already answered. */
export const APP_FEEDBACK_PROMPT_KEY = "app_feedback_prompt_state";
export const EXTENSION_REVIEW_PROMPT_KEY = "extension_review_prompt_state";

/** Unix seconds of the last ask the reader answered, across every question.
 *  Backs the gap above, which is a property of the reader's attention rather
 *  than of any one question. */
export const FEEDBACK_LAST_PROMPT_KEY = "feedback_prompt_last_shown";

/** The value a reader's answer leaves behind. */
export const PROMPT_ANSWERED = "done";

/**
 * What has already happened to one ask.
 *
 * There is no per-ask "refused" state, deliberately. "Don't ask again" is not a
 * verdict on the question in front of the reader, it is a verdict on being
 * asked, so it clears FEEDBACK_PROMPTS_ENABLED_KEY and silences every question
 * at once. Retiring only the current one would answer a reader who said stop
 * with a different question six weeks later, which is the same refusal ignored.
 * That switch is the one in Settings, so the decision stays visible and
 * reversible rather than vanishing into a row nobody can find.
 */
export type PromptState =
  | { kind: "unasked" }
  /** Answered, in either direction. An ask is a one-time event. */
  | { kind: "answered" }
  /** Snoozed at `sinceSec`; due again FEEDBACK_SNOOZE_DAYS later. */
  | { kind: "snoozed"; sinceSec: number };

export function parsePromptState(raw: string | undefined): PromptState {
  if (raw === undefined || raw === "") return { kind: "unasked" };
  if (raw === PROMPT_ANSWERED) return { kind: "answered" };
  const sinceSec = Number(raw);
  // An unparseable value is treated as already dealt with rather than as
  // unasked. A corrupt row must not become a prompt that reappears on every
  // launch, which is the one failure mode a reader cannot escape.
  if (!Number.isFinite(sinceSec)) return { kind: "answered" };
  return { kind: "snoozed", sinceSec };
}

/** Whether a snooze has run out. A stored time in the future means the clock
 *  moved backwards — a timezone change, an NTP correction — and must not park
 *  the ask two weeks out; the same reasoning as shouldCheckForUpdates. */
export function snoozeElapsed(sinceSec: number, nowSec: number): boolean {
  if (sinceSec > nowSec) return true;
  return nowSec - sinceSec >= FEEDBACK_SNOOZE_DAYS * 86_400;
}

export function feedbackPromptsEnabled(settings: Record<string, string>): boolean {
  return settings[FEEDBACK_PROMPTS_ENABLED_KEY] !== "0";
}

export type FeedbackPromptId = "app_feedback" | "extension_review";

export interface FeedbackPlan {
  id: FeedbackPromptId;
  /** The settings key carrying this ask's own state. */
  stateKey: string;
  /**
   * The store serving this reader's own browser, for "extension_review" only.
   *
   * Never null on that plan: an ask with nowhere to send the reader is not
   * raised at all. See `extensionReviewReachable`.
   */
  listing: PublishedTimeExtensionListing | null;
}

export interface FeedbackPromptContext {
  settings: Record<string, string>;
  nowSec: number;
  /** Unix seconds of the earliest recorded session; null on an empty database. */
  firstSessionSec: number | null;
  /** Distinct local days carrying at least one recorded session. */
  activeDays: number;
  /** True only in the `recording` state. Nothing is asked of a reader whose
   *  tracker is paused, descheduled, stopped, or off. */
  recording: boolean;
  /** The reader has made at least one rule of their own, which is the cheapest
   *  honest evidence that they invested in Time rather than merely installed
   *  it. Starter categories arrive unasked and prove nothing. */
  hasOwnRules: boolean;
  /** Time has just visibly paid off — see App for what currently qualifies.
   *  Not required once FEEDBACK_MILESTONE_FALLBACK_DAYS has passed. */
  atMilestone: boolean;
  /** Domains are reaching Time, which is the only available proof that the
   *  extension is installed *and* working. Windows cannot be asked directly;
   *  see the note on websiteSignalConfirmed. */
  extensionWorking: boolean;
  /** The listing serving the reader's default browser, published or not. */
  extensionListing: TimeExtensionListing | null;
}

/** Days of history behind the reader, or 0 on an empty database. */
export function historyDays(firstSessionSec: number | null, nowSec: number): number {
  if (firstSessionSec === null || firstSessionSec > nowSec) return 0;
  return (nowSec - firstSessionSec) / 86_400;
}

/**
 * The floor every ask sits behind: enough elapsed time, enough real use, a
 * tracker that is working, and some sign the reader made Time their own.
 */
export function feedbackFloorReached(context: FeedbackPromptContext): boolean {
  if (!context.recording) return false;
  if (!context.hasOwnRules) return false;
  if (context.activeDays < FEEDBACK_MIN_ACTIVE_DAYS) return false;
  return historyDays(context.firstSessionSec, context.nowSec) >= FEEDBACK_MIN_HISTORY_DAYS;
}

/** Whether a first-time ask may fire yet: at a milestone, or past the point
 *  where waiting for one has become waiting forever. */
export function milestoneReached(context: FeedbackPromptContext): boolean {
  if (context.atMilestone) return true;
  return historyDays(context.firstSessionSec, context.nowSec) >= FEEDBACK_MILESTONE_FALLBACK_DAYS;
}

/** Whether the gap since the last ask of any kind has elapsed. */
export function promptGapElapsed(settings: Record<string, string>, nowSec: number): boolean {
  const lastSec = Number(settings[FEEDBACK_LAST_PROMPT_KEY]);
  if (!Number.isFinite(lastSec) || lastSec <= 0) return true;
  if (lastSec > nowSec) return true;
  return nowSec - lastSec >= FEEDBACK_PROMPT_GAP_DAYS * 86_400;
}

/**
 * Whether the extension ask has anywhere to send this reader.
 *
 * An unpublished store is not a reason to substitute a different question. The
 * whole point of this ask is a public review, and a reader whose browser has no
 * listing yet — Edge, today — has already had the app ask, which routes to
 * email. Replacing a review request with a second email request would be a
 * fresh interruption offering nothing new.
 */
export function extensionReviewReachable(
  listing: TimeExtensionListing | null,
): listing is PublishedTimeExtensionListing {
  return listing !== null && isPublished(listing);
}

/**
 * The one ask this reader has earned, or null for silence.
 *
 * Order is the app question, then the extension question, and a live app
 * question blocks the extension one even while snoozed. Falling through to a
 * different ask because the reader said "Not now" to this one is exactly the
 * behaviour that teaches people to dismiss everything on sight.
 */
export function feedbackPromptFor(context: FeedbackPromptContext): FeedbackPlan | null {
  if (!feedbackPromptsEnabled(context.settings)) return null;
  if (!feedbackFloorReached(context)) return null;

  const app = parsePromptState(context.settings[APP_FEEDBACK_PROMPT_KEY]);
  if (app.kind === "unasked") {
    if (!milestoneReached(context) || !promptGapElapsed(context.settings, context.nowSec)) {
      return null;
    }
    return { id: "app_feedback", stateKey: APP_FEEDBACK_PROMPT_KEY, listing: null };
  }
  if (app.kind === "snoozed") {
    // A retry needs no milestone: the reader has already been asked, and the
    // question now is only whether enough time has passed.
    if (!snoozeElapsed(app.sinceSec, context.nowSec)) return null;
    return { id: "app_feedback", stateKey: APP_FEEDBACK_PROMPT_KEY, listing: null };
  }

  if (!context.extensionWorking) return null;
  if (!extensionReviewReachable(context.extensionListing)) return null;
  const listing = context.extensionListing;

  const extension = parsePromptState(context.settings[EXTENSION_REVIEW_PROMPT_KEY]);
  if (extension.kind === "unasked") {
    if (!promptGapElapsed(context.settings, context.nowSec)) return null;
    return { id: "extension_review", stateKey: EXTENSION_REVIEW_PROMPT_KEY, listing };
  }
  if (extension.kind === "snoozed" && snoozeElapsed(extension.sinceSec, context.nowSec)) {
    return { id: "extension_review", stateKey: EXTENSION_REVIEW_PROMPT_KEY, listing };
  }
  return null;
}
