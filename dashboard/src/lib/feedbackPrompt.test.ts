import { describe, expect, it } from "vitest";

import { PUBLISHED_TIME_EXTENSION_LISTINGS, type TimeExtensionListing } from "./browserExtensions";
import {
  APP_FEEDBACK_PROMPT_KEY,
  EXTENSION_REVIEW_PROMPT_KEY,
  FEEDBACK_LAST_PROMPT_KEY,
  FEEDBACK_MILESTONE_FALLBACK_DAYS,
  FEEDBACK_MIN_ACTIVE_DAYS,
  FEEDBACK_MIN_HISTORY_DAYS,
  FEEDBACK_PROMPT_GAP_DAYS,
  FEEDBACK_PROMPTS_ENABLED_KEY,
  FEEDBACK_SNOOZE_DAYS,
  feedbackPromptFor,
  parsePromptState,
  PROMPT_ANSWERED,
  snoozeElapsed,
  type FeedbackPromptContext,
} from "./feedbackPrompt";

const NOW = 1_800_000_000;
const DAY = 86_400;

const published = PUBLISHED_TIME_EXTENSION_LISTINGS[0];

/** Built rather than taken from the shipping registry: this case is about a
 *  listing with no store page, and it must keep testing that once Edge
 *  publishes. */
const unpublished: TimeExtensionListing = {
  browsers: "Edge",
  processes: ["msedge.exe"],
  store: "Microsoft Edge Add-ons",
  storeUrl: null,
};

/** A reader who has earned the app ask: past the milestone fallback, well used,
 *  recording, and organized. Each test knocks out one gate. */
function context(overrides: Partial<FeedbackPromptContext> = {}): FeedbackPromptContext {
  return {
    settings: {},
    nowSec: NOW,
    firstSessionSec: NOW - (FEEDBACK_MILESTONE_FALLBACK_DAYS + 15) * DAY,
    activeDays: 30,
    recording: true,
    hasOwnRules: true,
    atMilestone: false,
    extensionWorking: true,
    extensionListing: published,
    ...overrides,
  };
}

/** The state a reader leaves behind once the app ask is out of the way. */
const appAnswered = { [APP_FEEDBACK_PROMPT_KEY]: PROMPT_ANSWERED };

describe("feedbackPromptFor floor", () => {
  it("asks a reader who has earned it", () => {
    expect(feedbackPromptFor(context())?.id).toBe("app_feedback");
  });

  it("stays silent while the tracker is not recording", () => {
    // A paused, descheduled or dead tracker is never a moment to ask for a
    // favour, whatever the calendar says.
    expect(feedbackPromptFor(context({ recording: false }))).toBeNull();
  });

  it("stays silent for a reader who has made no rules of their own", () => {
    expect(feedbackPromptFor(context({ hasOwnRules: false }))).toBeNull();
  });

  it("stays silent below the active-day floor, however old the install", () => {
    // The case a day counter cannot see: months of history, barely used.
    expect(
      feedbackPromptFor(
        context({
          activeDays: FEEDBACK_MIN_ACTIVE_DAYS - 1,
          firstSessionSec: NOW - 365 * DAY,
        }),
      ),
    ).toBeNull();
  });

  it("stays silent below the history floor, however heavy the use", () => {
    expect(
      feedbackPromptFor(
        context({
          firstSessionSec: NOW - (FEEDBACK_MIN_HISTORY_DAYS - 1) * DAY,
          activeDays: 100,
          atMilestone: true,
        }),
      ),
    ).toBeNull();
  });

  it("stays silent on an empty database", () => {
    expect(feedbackPromptFor(context({ firstSessionSec: null }))).toBeNull();
  });

  it("stays silent when the reader switched prompts off", () => {
    expect(
      feedbackPromptFor(context({ settings: { [FEEDBACK_PROMPTS_ENABLED_KEY]: "0" } })),
    ).toBeNull();
  });

  it("treats an unwritten enabled row as enabled", () => {
    // The tracker may not have backfilled the default yet; an absent row is
    // not an opt-out.
    expect(feedbackPromptFor(context())?.id).toBe("app_feedback");
  });
});

describe("feedbackPromptFor milestone", () => {
  const justPastFloor = NOW - (FEEDBACK_MIN_HISTORY_DAYS + 1) * DAY;

  it("waits for a milestone between the floor and the fallback", () => {
    expect(feedbackPromptFor(context({ firstSessionSec: justPastFloor }))).toBeNull();
  });

  it("asks at a milestone once the floor is behind the reader", () => {
    expect(
      feedbackPromptFor(context({ firstSessionSec: justPastFloor, atMilestone: true }))?.id,
    ).toBe("app_feedback");
  });

  it("asks without a milestone once the fallback has passed", () => {
    // Otherwise a reader whose backlog is never empty is never asked at all.
    expect(feedbackPromptFor(context({ atMilestone: false }))?.id).toBe("app_feedback");
  });
});

describe("feedbackPromptFor ordering", () => {
  it("asks about the app before the extension", () => {
    expect(feedbackPromptFor(context())?.id).toBe("app_feedback");
  });

  it("moves to the extension once the app ask is answered", () => {
    const plan = feedbackPromptFor(context({ settings: appAnswered }));
    expect(plan?.id).toBe("extension_review");
    expect(plan?.listing).toEqual(published);
  });

  it("silences every ask when the reader refuses to be asked", () => {
    // "Don't ask again" clears the shared switch rather than retiring one
    // question, so it cannot be answered with a different question later.
    expect(
      feedbackPromptFor(
        context({ settings: { ...appAnswered, [FEEDBACK_PROMPTS_ENABLED_KEY]: "0" } }),
      ),
    ).toBeNull();
  });

  it("does not let the extension ask jump a snoozed app ask", () => {
    // Falling through to a different question because the reader said "Not
    // now" is what teaches people to dismiss everything on sight.
    expect(
      feedbackPromptFor(
        context({ settings: { [APP_FEEDBACK_PROMPT_KEY]: String(NOW - 2 * DAY) } }),
      ),
    ).toBeNull();
  });

  it("retries the app ask once its snooze runs out", () => {
    expect(
      feedbackPromptFor(
        context({
          settings: { [APP_FEEDBACK_PROMPT_KEY]: String(NOW - (FEEDBACK_SNOOZE_DAYS + 1) * DAY) },
        }),
      )?.id,
    ).toBe("app_feedback");
  });

  it("retries a snoozed ask without requiring a fresh milestone", () => {
    expect(
      feedbackPromptFor(
        context({
          firstSessionSec: NOW - (FEEDBACK_MIN_HISTORY_DAYS + 1) * DAY,
          atMilestone: false,
          settings: { [APP_FEEDBACK_PROMPT_KEY]: String(NOW - (FEEDBACK_SNOOZE_DAYS + 1) * DAY) },
        }),
      )?.id,
    ).toBe("app_feedback");
  });

  it("says nothing once both asks are done", () => {
    expect(
      feedbackPromptFor(
        context({
          settings: { ...appAnswered, [EXTENSION_REVIEW_PROMPT_KEY]: PROMPT_ANSWERED },
        }),
      ),
    ).toBeNull();
  });
});

describe("feedbackPromptFor gap", () => {
  it("holds the second ask until the gap has elapsed", () => {
    expect(
      feedbackPromptFor(
        context({
          settings: { ...appAnswered, [FEEDBACK_LAST_PROMPT_KEY]: String(NOW - 5 * DAY) },
        }),
      ),
    ).toBeNull();
  });

  it("allows the second ask once the gap has elapsed", () => {
    expect(
      feedbackPromptFor(
        context({
          settings: {
            ...appAnswered,
            [FEEDBACK_LAST_PROMPT_KEY]: String(NOW - (FEEDBACK_PROMPT_GAP_DAYS + 1) * DAY),
          },
        }),
      )?.id,
    ).toBe("extension_review");
  });

  it("treats a stamp in the future as elapsed", () => {
    // A clock that moved backwards must not park the next ask a month and a
    // half out.
    expect(
      feedbackPromptFor(
        context({
          settings: { ...appAnswered, [FEEDBACK_LAST_PROMPT_KEY]: String(NOW + 10 * DAY) },
        }),
      )?.id,
    ).toBe("extension_review");
  });
});

describe("feedbackPromptFor extension review", () => {
  it("stays silent while no domains are arriving", () => {
    // The only available proof the extension is installed and working.
    expect(
      feedbackPromptFor(context({ settings: appAnswered, extensionWorking: false })),
    ).toBeNull();
  });

  it("stays silent when the reader's browser has no published listing", () => {
    // Nowhere to send them, and a second email request is not a substitute for
    // a review request.
    expect(
      feedbackPromptFor(context({ settings: appAnswered, extensionListing: unpublished })),
    ).toBeNull();
  });

  it("stays silent when no listing serves the reader's browser at all", () => {
    expect(
      feedbackPromptFor(context({ settings: appAnswered, extensionListing: null })),
    ).toBeNull();
  });

  it("carries the store serving this reader", () => {
    expect(feedbackPromptFor(context({ settings: appAnswered }))?.listing?.storeUrl).toBe(
      published.storeUrl,
    );
  });
});

describe("parsePromptState", () => {
  it("reads an absent or empty value as unasked", () => {
    expect(parsePromptState(undefined)).toEqual({ kind: "unasked" });
    expect(parsePromptState("")).toEqual({ kind: "unasked" });
  });

  it("reads the answered marker", () => {
    expect(parsePromptState(PROMPT_ANSWERED)).toEqual({ kind: "answered" });
  });

  it("reads a numeric value as a snooze stamp", () => {
    expect(parsePromptState(String(NOW))).toEqual({ kind: "snoozed", sinceSec: NOW });
  });

  it("treats a corrupt value as already dealt with", () => {
    // Not as unasked: a row nobody can parse must not become a prompt that
    // reappears on every launch with no way out.
    expect(parsePromptState("what")).toEqual({ kind: "answered" });
  });
});

describe("snoozeElapsed", () => {
  it("holds the ask for the snooze window", () => {
    expect(snoozeElapsed(NOW - (FEEDBACK_SNOOZE_DAYS - 1) * DAY, NOW)).toBe(false);
  });

  it("releases the ask after it", () => {
    expect(snoozeElapsed(NOW - (FEEDBACK_SNOOZE_DAYS + 1) * DAY, NOW)).toBe(true);
  });

  it("releases an ask snoozed in the future", () => {
    expect(snoozeElapsed(NOW + DAY, NOW)).toBe(true);
  });
});
