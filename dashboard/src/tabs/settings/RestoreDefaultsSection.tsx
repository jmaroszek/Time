import { useState } from "react";

import { ConfirmDialog } from "../../components/ui";
import { restoreDefaultSettings } from "../../lib/queries";
import { useBanner } from "../../state/banner";
import { useMeta } from "../../state/meta";
import { Section } from "./chrome";
import { Row, TextAction } from "./fields";

export default function RestoreDefaultsSection({
  disabled,
  onRestored,
}: {
  disabled: boolean;
  onRestored: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const restore = async () => {
    if (disabled || restoring) return;
    setRestoring(true);
    setRestored(false);
    try {
      await restoreDefaultSettings();
      await meta.refresh();
      onRestored();
      setRestored(true);
      setTimeout(() => setRestored(false), 2_000);
      setConfirming(false);
    } catch (error) {
      banner.report(error, "default settings");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Section title="Defaults">
      {confirming && (
        <ConfirmDialog
          title="Restore default settings?"
          body="Every setting on this page returns to its default, including recording and Windows startup, which will be turned off."
          note="Recorded history, categories, rules, aliases, exclusions, corrections, and backups are not touched."
          confirmLabel="Restore defaults"
          busyLabel="Restoring…"
          busy={restoring}
          confirmDisabled={disabled}
          // Not "danger": this resets preferences and destroys no data. The red
          // button is reserved for the ones that remove recorded activity.
          variant="default"
          onConfirm={() => void restore()}
          onClose={() => setConfirming(false)}
        />
      )}
      <Row
        label="Restore default settings"
        help="Resets every setting on this page without changing recorded history."
        control={
          <TextAction
            disabled={disabled || restoring}
            title={disabled ? "Wait for settings to finish saving" : undefined}
            onClick={() => setConfirming(true)}
          >
            {restoring ? "Restoring…" : restored ? "Defaults restored" : "Restore defaults"}
          </TextAction>
        }
      />
    </Section>
  );
}

/** One card, one story: where the data lives, how to save it, how to shed it.
 *  Retention sits with backups because the safe order is back up, then delete —
 *  and it ends in the danger row so the destructive step is last, not floating
 *  in its own card. Lifecycle-level deletion stays in Settings; exact record
 *  correction lives in Activity. */
