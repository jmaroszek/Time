import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "../../components/ui";
import { updateButtonLabel } from "../../lib/appUpdate";
import { SUPPORT_EMAIL, WEBSITE_URL, supportEmailUrl } from "../../lib/support";
import { useBanner } from "../../state/banner";
import type { AppUpdateState } from "../../state/useAppUpdate";
import { Section } from "./chrome";
import { Row, TextAction } from "./fields";

/** What's installed, whether it's current, and where Time lives online — the
 *  things a reader looks for under "About" in any app. The versions also travel
 *  with a support email, so a report is actionable without the sender having to
 *  copy them from here. */
export default function HelpAndFeedbackSection({
  appVersion,
  trackerVersion,
  update,
}: {
  appVersion: string | null;
  trackerVersion: string | undefined;
  update: AppUpdateState;
}) {
  const banner = useBanner();

  const emailSupport = async () => {
    try {
      await openUrl(supportEmailUrl({ dashboardVersion: appVersion, trackerVersion }));
    } catch (error) {
      banner.report(error, "opening an email to Time support");
    }
  };

  const openWebsite = async () => {
    try {
      await openUrl(WEBSITE_URL);
    } catch (error) {
      banner.report(error, "opening the Time website");
    }
  };

  const checkResult =
    update.manualCheck === "current"
      ? "Time is up to date."
      : update.manualCheck === "failed"
        ? "Couldn't reach the update server. Check your connection and try again."
        : update.manualCheck === "available" && update.available
          ? `Version ${update.available.version} is ready to install.`
          : null;

  return (
    <Section title="About & help">
      <Row
        label="Version"
        help={
          <>
            Dashboard {appVersion ?? "—"} · Tracker {trackerVersion ?? "not stamped yet"}
            {checkResult && (
              <span className="mt-1 block" role="status">
                {checkResult}
              </span>
            )}
          </>
        }
        control={
          // Blue, unlike the other actions here: being on the latest version
          // is the one thing on this page worth nudging people toward.
          <Button
            variant="accent"
            disabled={update.available ? update.installing : update.manualCheck === "checking"}
            onClick={update.available ? update.install : update.checkNow}
            className="-mr-3 max-sm:-ml-3 max-sm:mr-0"
          >
            {update.available
              ? updateButtonLabel(update.available, update.installing, update.progress)
              : update.manualCheck === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        }
      />
      <Row
        label="Website"
        help="The latest installer, the browser extension, how Time handles your data, and answers to common questions."
        control={<TextAction onClick={() => void openWebsite()}>Open trackwithtime.com</TextAction>}
      />
      <Row
        label="Contact support"
        help={
          <>
            Questions, bugs, or ideas? Write to{" "}
            <span className="font-medium text-ink-2">{SUPPORT_EMAIL}</span>.
          </>
        }
        control={<TextAction onClick={() => void emailSupport()}>Email support</TextAction>}
      />
    </Section>
  );
}
