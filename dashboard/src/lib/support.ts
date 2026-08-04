export const SUPPORT_EMAIL = "support@trackwithtime.com";

export interface SupportVersions {
  dashboardVersion?: string | null;
  trackerVersion?: string | null;
}

/** Keep the first report useful without collecting anything automatically.
 *  The diagnostic versions are already visible in Settings; the rest stays in
 *  the sender's control because activity details can be sensitive. */
export function supportEmailUrl({
  dashboardVersion,
  trackerVersion,
}: SupportVersions): string {
  const dashboard = dashboardVersion ?? "not available";
  const tracker = trackerVersion ?? "not stamped yet";
  const subject = "Time support or feedback";
  const body = [
    "What would you like to share?",
    "",
    "If you are reporting a problem, please include your Windows version, what you expected, what happened, and the steps that reproduce it.",
    "",
    `Time versions: Dashboard ${dashboard} · Tracker ${tracker}`,
  ].join("\n");

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
