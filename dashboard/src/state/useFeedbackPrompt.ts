// Owns the evidence the feedback arbiter needs and nothing else. The decision
// rules live in lib/feedbackPrompt.ts so they can be tested without a renderer;
// what is left here is when it is worth going to the database to ask.
//
// The two reads below are gated behind the cheap half of the floor — history
// age, which App already knows, plus the switches — so a fresh install never
// pays for them. An established reader pays once per launch. Neither is on the
// path to anything the reader is waiting for.

import { useEffect, useRef, useState } from "react";

import {
  listingForProgId,
  type TimeExtensionListing,
} from "../lib/browserExtensions";
import {
  feedbackPromptFor,
  feedbackPromptsEnabled,
  FEEDBACK_MIN_ACTIVE_DAYS,
  FEEDBACK_MIN_HISTORY_DAYS,
  historyDays,
  type FeedbackPlan,
} from "../lib/feedbackPrompt";
import { fetchActiveDayCount } from "../lib/queries";

export interface FeedbackPromptInput {
  /** False whenever something louder is on screen, or the app is not ready.
   *  A recording problem outranks a favour; see the note in App. */
  enabled: boolean;
  settings: Record<string, string>;
  firstSessionSec: number | null;
  /** True only in the `recording` state. */
  recording: boolean;
  /** The reader has rules of their own. Rules are not seeded — only categories
   *  are — so any rule at all was made by someone. */
  hasOwnRules: boolean;
  atMilestone: boolean;
  extensionWorking: boolean;
}

export interface FeedbackPromptState {
  plan: FeedbackPlan | null;
  /** Whole days since the first recorded session, for the email footer. */
  daysOfUse: number | null;
  appVersion: string | null;
}

export function useFeedbackPrompt(input: FeedbackPromptInput): FeedbackPromptState {
  const [activeDays, setActiveDays] = useState<number | null>(null);
  const [listing, setListing] = useState<TimeExtensionListing | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Both answers are stable for the life of a launch, and settings arrive as a
  // fresh object on every write anywhere in the app. Without these the effects
  // would re-run on each one.
  const countAsked = useRef(false);
  const listingAsked = useRef(false);

  const nowSec = Date.now() / 1000;
  // The cheap half of the floor, checked before spending anything on the rest.
  // Active days is the expensive question and the one this defers.
  const worthAsking =
    input.enabled
    && input.recording
    && input.hasOwnRules
    && feedbackPromptsEnabled(input.settings)
    && historyDays(input.firstSessionSec, nowSec) >= FEEDBACK_MIN_HISTORY_DAYS;

  useEffect(() => {
    if (!worthAsking || countAsked.current) return;
    countAsked.current = true;
    void fetchActiveDayCount(FEEDBACK_MIN_ACTIVE_DAYS)
      .then(setActiveDays)
      // A failed count leaves the floor unmet, which is silence. There is no
      // version of this worth reporting to a reader.
      .catch(() => {});
  }, [worthAsking]);

  useEffect(() => {
    if (!worthAsking || listingAsked.current) return;
    listingAsked.current = true;
    // Imported lazily so a renderer running outside Tauri — the device fixture,
    // a plain vite dev server — never loads the bridge at all.
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("default_browser_prog_id"))
      .then((progId) => setListing(listingForProgId(progId)))
      .catch(() => {});
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, [worthAsking]);

  const plan = input.enabled
    ? feedbackPromptFor({
      settings: input.settings,
      nowSec,
      firstSessionSec: input.firstSessionSec,
      activeDays: activeDays ?? 0,
      recording: input.recording,
      hasOwnRules: input.hasOwnRules,
      atMilestone: input.atMilestone,
      extensionWorking: input.extensionWorking,
      extensionListing: listing,
    })
    : null;

  const daysOfUse = input.firstSessionSec === null
    ? null
    : Math.floor(historyDays(input.firstSessionSec, nowSec));

  return { plan, daysOfUse, appVersion };
}
