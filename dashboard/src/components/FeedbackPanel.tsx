// The one place Time asks the reader for something.
//
// Two steps, not one. The first asks how Time is going and commits the reader
// to nothing; the second is where the ask actually lands, and which ask it is
// depends on the answer. Someone whose Time is misbehaving is not asked to go
// and praise it in public — they are asked what is wrong, which is the thing
// worth having from them anyway.
//
// Every route out of here is a handoff, never a transmission: `openUrl` hands
// a draft to the reader's own mail client or a store page to their own browser,
// through the shell rather than the webview. Nothing is sent, nothing is
// collected, and the reader reads the whole message before any of it moves.
// That is what keeps `dashboard/src` free of `fetch` and the README's claim
// true; see the note in lib/support.ts on why the subjects are literals.

import { useState, type ReactNode } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import { openExtensionStorePage } from "../lib/browserExtensions";
import {
  FEEDBACK_LAST_PROMPT_KEY,
  FEEDBACK_PROMPTS_ENABLED_KEY,
  PROMPT_ANSWERED,
  type FeedbackPlan,
} from "../lib/feedbackPrompt";
import { updateSetting, updateSettings } from "../lib/queries";
import { supportEmailUrl, type SupportTopic } from "../lib/support";
import { useBanner } from "../state/banner";
import { useMeta } from "../state/meta";
import { Button } from "./ui";

/** Which half of the gate the reader is in. */
type Step = "ask" | "positive" | "negative";

export interface FeedbackPanelProps {
  plan: FeedbackPlan;
  /** Days since the first recorded session, for the email footer. */
  daysOfUse: number | null;
  appVersion: string | null;
  trackerVersion: string | undefined;
}

export function FeedbackPanel({
  plan,
  daysOfUse,
  appVersion,
  trackerVersion,
}: FeedbackPanelProps) {
  const meta = useMeta();
  const banner = useBanner();
  const [step, setStep] = useState<Step>("ask");
  const [busy, setBusy] = useState(false);
  const extension = plan.id === "extension_review";

  /** Retire this question and stamp the gap before the next one. One
   *  transaction: a stamp that failed on its own would let the second ask
   *  arrive immediately after the first. */
  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await updateSettings([
        { key: plan.stateKey, value: PROMPT_ANSWERED },
        { key: FEEDBACK_LAST_PROMPT_KEY, value: String(Math.floor(Date.now() / 1000)) },
      ]);
      await meta.refresh();
    } catch (error) {
      banner.report(error, "saving your answer");
      setBusy(false);
    }
  };

  const snooze = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await updateSetting(plan.stateKey, String(Math.floor(Date.now() / 1000)));
      await meta.refresh();
    } catch (error) {
      banner.report(error, "saving your answer");
      setBusy(false);
    }
  };

  /** "Don't ask again" is about being asked, not about this question, so it
   *  clears the shared switch. Settings shows the same one, which is where a
   *  reader who changes their mind can find it. */
  const silence = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await updateSetting(FEEDBACK_PROMPTS_ENABLED_KEY, "0");
      await meta.refresh();
    } catch (error) {
      banner.report(error, "turning feedback prompts off");
      setBusy(false);
    }
  };

  /** Open a draft, then retire the question. The retirement does not wait on
   *  the mail client: a reader with no handler registered has still answered,
   *  and asking them again in a fortnight would be the app arguing with them. */
  const email = async (topic: SupportTopic) => {
    try {
      await openUrl(supportEmailUrl({
        dashboardVersion: appVersion,
        trackerVersion,
        daysOfUse,
      }, topic));
    } catch (error) {
      banner.report(error, "opening an email to Time support");
    }
    await finish();
  };

  const review = async () => {
    if (plan.listing === null) return;
    try {
      await openExtensionStorePage(plan.listing);
    } catch (error) {
      banner.report(error, "opening the Time extension page");
    }
    await finish();
  };

  if (step === "ask") {
    return (
      <Panel
        title={extension ? "Is the Time Web Extension working for you?" : "How is Time working for you?"}
        detail={
          extension
            ? "Websites are reaching Time, so the extension is doing its job. One question while it is."
            : "You have been using Time for a while now. One question, and then this goes away."
        }
        busy={busy}
        onSnooze={() => void snooze()}
        onSilence={() => void silence()}
      >
        <Button variant="primary" disabled={busy} onClick={() => setStep("positive")}>
          {extension ? "Yes, it works" : "Going well"}
        </Button>
        <Button disabled={busy} onClick={() => setStep("negative")}>
          {extension ? "Not really" : "Not great"}
        </Button>
      </Panel>
    );
  }

  if (step === "positive") {
    return (
      <Panel
        title={extension ? "Would you leave it a review?" : "Would you tell me what is working?"}
        detail={
          extension
            ? `A short review on the ${plan.listing?.store} is the single most useful thing for an extension nobody has heard of yet.`
            : "Time has no reviews to collect, so a sentence by email is what there is — and I would like to quote it on the site, with your permission."
        }
        busy={busy}
        onSnooze={() => void snooze()}
        onSilence={() => void silence()}
      >
        {extension ? (
          <Button variant="primary" disabled={busy} onClick={() => void review()}>
            Open {plan.listing?.store}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void email("praise")}>
            Write a sentence
          </Button>
        )}
        <Button disabled={busy} onClick={() => void finish()}>
          No thanks
        </Button>
      </Panel>
    );
  }

  return (
    <Panel
      title={extension ? "What is it getting wrong?" : "What would you change?"}
      detail={
        extension
          ? "Tell me which browser and which sites, and I will try to fix it."
          : "I would rather hear it than not. Your email opens with the questions already in it — nothing is sent until you send it."
      }
      busy={busy}
      onSnooze={() => void snooze()}
      onSilence={() => void silence()}
    >
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => void email(extension ? "extension" : "problem")}
      >
        Tell me what is wrong
      </Button>
      <Button disabled={busy} onClick={() => void finish()}>
        No thanks
      </Button>
    </Panel>
  );
}

/**
 * Quiet chrome, deliberately.
 *
 * The accent frame belongs to the welcome and the warn frame to a tracker that
 * has stopped. This is neither: nothing is wrong and nothing has changed, Time
 * is asking a favour. It should look like the least urgent thing on the page,
 * because it is.
 */
function Panel({
  title,
  detail,
  children,
  busy,
  onSnooze,
  onSilence,
}: {
  title: string;
  detail: string;
  children: ReactNode;
  busy: boolean;
  onSnooze: () => void;
  onSilence: () => void;
}) {
  return (
    <section className="rounded-[14px] border border-edge bg-surface-dim px-5 py-3 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-row font-semibold">{title}</p>
          <p className="mt-[3px] text-ink-2">{detail}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {children}
          {/* Both exits stay reachable at every step. A reader who opened the
              second half and changed their mind must not have to answer to
              leave. */}
          <button
            type="button"
            disabled={busy}
            onClick={onSnooze}
            className="rounded-md px-2 py-1 text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink disabled:opacity-50"
          >
            Not now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSilence}
            className="rounded-md px-2 py-1 text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink disabled:opacity-50"
          >
            Don't ask again
          </button>
        </div>
      </div>
    </section>
  );
}
