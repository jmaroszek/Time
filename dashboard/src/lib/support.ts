export const SUPPORT_EMAIL = "support@trackwithtime.com";

/**
 * Which conversation the reader is starting.
 *
 * The prompts route a reader who is happy and a reader who is not to different
 * drafts, because the two need different questions. Every one of them still
 * lands in the same inbox as an ordinary email the sender can read and edit
 * before it goes.
 */
export type SupportTopic = "general" | "praise" | "problem" | "extension";

export interface SupportContext {
  dashboardVersion?: string | null;
  trackerVersion?: string | null;
  /** Days since the reader's first recorded session, when the caller knows it.
   *  Answers the first question any report raises — how long has this been
   *  going on — without collecting anything the sender cannot see and delete. */
  daysOfUse?: number | null;
}

/** Subjects are literals rather than composed strings: each one is pinned in
 *  the opener allowlist in src-tauri/capabilities/default.json, and a subject
 *  that does not match a pinned entry is refused at runtime rather than at
 *  build time. Change one here and change it there. */
const SUBJECTS: Record<SupportTopic, string> = {
  general: "Time support or feedback",
  praise: "Time feedback: what is working",
  problem: "Time feedback: what is not working",
  extension: "Time Web Extension: what is not working",
};

const BODIES: Record<SupportTopic, string[]> = {
  general: [
    "What would you like to share?",
    "",
    "If you are reporting a problem, please include your Windows version, what you expected, what happened, and the steps that reproduce it.",
  ],
  praise: [
    "Thank you — it genuinely helps to hear this.",
    "",
    "What is Time doing best for you?",
    "",
    "What is the one thing you would still change?",
    "",
    "May I quote you on trackwithtime.com? Say no and I will not; it changes nothing else.",
  ],
  problem: [
    "Tell me what is wrong and I will try to fix it.",
    "",
    "What went wrong?",
    "",
    "What did you expect instead?",
    "",
    "If it happens reliably, the steps that cause it.",
    "",
    "Your Windows version, which Time does not collect on its own.",
  ],
  extension: [
    "Tell me what the Time Web Extension is getting wrong and I will try to fix it.",
    "",
    "Which browser, and which websites are affected?",
    "",
    "Are they missing from Activity entirely, or recorded under the wrong name?",
  ],
};

/** Keep the first report useful without collecting anything automatically.
 *  The diagnostic versions are already visible in Settings; the rest stays in
 *  the sender's control because activity details can be sensitive. */
export function supportEmailUrl(
  { dashboardVersion, trackerVersion, daysOfUse }: SupportContext,
  topic: SupportTopic = "general",
): string {
  const dashboard = dashboardVersion ?? "not available";
  const tracker = trackerVersion ?? "not stamped yet";
  const footer = [`Time versions: Dashboard ${dashboard} · Tracker ${tracker}`];
  if (daysOfUse !== null && daysOfUse !== undefined && Number.isFinite(daysOfUse)) {
    const days = Math.max(0, Math.floor(daysOfUse));
    footer.push(`Using Time for ${days} day${days === 1 ? "" : "s"}`);
  }
  const body = [...BODIES[topic], "", ...footer].join("\n");

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUBJECTS[topic])}&body=${encodeURIComponent(body)}`;
}

/** The exact subject a topic sends, for the allowlist test to pin against. */
export function supportSubject(topic: SupportTopic): string {
  return SUBJECTS[topic];
}
