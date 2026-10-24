import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../../components/ui";
import { GOAL_MAX_HOURS } from "../../lib/categoryGoals";
import type { CategoryGoal, GoalKind } from "../../lib/classify";
import { Segmented } from "../settings/fields";

export const GOAL_EDITOR_WIDTH = 264;

const KIND_LABELS: Record<GoalKind, string> = { at_least: "At least", at_most: "At most" };

/**
 * A category's weekly goal, edited in place like its colour: anchored to the
 * row and rendered through a portal, so the scrolling category list can't clip
 * it. Saving 0 hours removes the goal, the rule the overall goal's field in
 * Settings already follows; "Remove goal" says it outright.
 */
export default function GoalEditor({
  categoryName,
  goal,
  left,
  top,
  onSave,
  onClose,
}: {
  categoryName: string;
  goal: CategoryGoal | undefined;
  left: number;
  top: number;
  /** Null removes the goal. */
  onSave: (goal: CategoryGoal | null) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? "at_least");
  const [hours, setHours] = useState(goal ? String(goal.hours) : "");
  const parsed = /^\d+$/.test(hours.trim()) ? Number(hours.trim()) : null;
  const valid = parsed !== null && parsed <= GOAL_MAX_HOURS;
  const save = () => {
    if (!valid) return;
    onSave(parsed === 0 ? null : { hours: parsed, kind });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <button type="button" aria-label="Close goal editor" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-label={`Weekly goal for ${categoryName}`}
        style={{ left, top, width: GOAL_EDITOR_WIDTH }}
        className="menu-pop fixed z-50 flex flex-col gap-3 rounded-[11px] border border-raised-edge bg-raised p-3 text-xs shadow-menu"
      >
        {/* self-start: a column stretches its children, and the switch's frame
            should hug its two options rather than run on past them. */}
        <div className="self-start">
          <Segmented
            label="Goal kind"
            options={["at_least", "at_most"]}
            labels={KIND_LABELS}
            value={kind}
            onChange={(value) => setKind(value as GoalKind)}
          />
        </div>
        <label className="flex items-center gap-2 text-ink-2">
          <input
            autoFocus
            inputMode="numeric"
            value={hours}
            aria-label={`Hours a week for ${categoryName}`}
            aria-invalid={hours !== "" && !valid}
            onChange={(event) => setHours(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") save(); }}
            className={`w-14 rounded-lg border bg-control px-2.5 py-1.5 text-right tabular-nums text-ink outline-none focus:border-accent/60 ${
              hours !== "" && !valid ? "border-bad/60" : "border-control-edge"
            }`}
          />
          hours a week
        </label>
        <p className="leading-relaxed text-ink-3">
          Goal progress is shown in Insights.
        </p>
        <div className="-mb-1 -mr-1 flex items-center">
          {/* The negative margin takes back the button's padding, so the word
              starts on the same edge as the switch, the field and the note. */}
          {goal && <Button variant="text-danger" className="-ml-[13px]" onClick={() => onSave(null)}>Remove goal</Button>}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={save}>Save</Button>
        </div>
      </div>
    </>,
    document.body,
  );
}
