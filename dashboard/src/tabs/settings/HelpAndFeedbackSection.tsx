import { openUrl } from "@tauri-apps/plugin-opener";

import { SUPPORT_EMAIL, supportEmailUrl } from "../../lib/support";
import { useBanner } from "../../state/banner";
import { Section } from "./chrome";
import { Row, TextAction } from "./fields";

/** The app versions that make a report actionable travel with the email
 *  itself rather than sitting in this section — the one place they're worth
 *  reading on their own is beside the update control in Privacy & recording,
 *  which already reports what's installed. */
export default function HelpAndFeedbackSection({
  appVersion,
  trackerVersion,
}: {
  appVersion: string | null;
  trackerVersion: string | undefined;
}) {
  const banner = useBanner();

  const emailSupport = async () => {
    try {
      await openUrl(supportEmailUrl({ dashboardVersion: appVersion, trackerVersion }));
    } catch (error) {
      banner.report(error, "opening an email to Time support");
    }
  };

  return (
    <Section title="Help & feedback">
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
