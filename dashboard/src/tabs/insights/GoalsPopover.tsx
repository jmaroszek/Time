import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { MENU_VIEWPORT_MARGIN } from "../../components/ui";
import { goalBarParts, goalTargetLabel, type GoalProgress } from "../../lib/categoryGoals";
import type { Category, GoalKind } from "../../lib/classify";
import { fmtDuration, fmtDurationTitle, fmtWholeHours } from "../../lib/format";
import type { GoalPace } from "../../lib/metrics";
import { GoalMark } from "./GoalMark";

const POPOVER_WIDTH = 300;

/**
 * Every goal in the range, opened from the Goal pace tile. The page keeps its
 * four tiles; a goal per tile would have added a row for what most readers
 * glance at once a week. The overall goal leads because it is the tile's own
 * figure; each category row narrows Insights to that category, as a category
 * anywhere else on the page does.
 */
export default function GoalsPopover({
  anchorRef,
  overall,
  goals,
  onSelectCategory,
  onClose,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  /** Null when no overall goal is set. */
  overall: GoalPace | null;
  goals: Array<{ category: Category; progress: GoalProgress }>;
  onSelectCategory: (category: Category) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const anyMark = (overall ? overall.met || overall.missed : false)
    || goals.some(({ progress }) => progress.met || progress.missed);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
      setBox({
        // Right edges aligned: the tile is the last of the row.
        left: Math.max(
          MENU_VIEWPORT_MARGIN,
          Math.min(anchor.right - width, window.innerWidth - width - MENU_VIEWPORT_MARGIN),
        ),
        top: anchor.bottom + 6,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The tile toggles the popover itself; closing here first would let that
      // same click open it again.
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Goals in this range"
      style={{
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        width: Math.min(POPOVER_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2),
        visibility: box ? "visible" : "hidden",
      }}
      className="menu-pop fixed z-[80] flex flex-col rounded-[11px] border border-raised-edge bg-raised p-1 shadow-menu"
    >
      <p className="px-2.5 pb-1 pt-2 text-micro font-medium uppercase tracking-[0.08em] text-ink-3-raised">
        Goals in this range
      </p>
      {overall && (
        <GoalRow
          name="Productive time"
          done={fmtWholeHours(overall.doneHours)}
          target={`of ${fmtWholeHours(overall.targetHours)}`}
          kind="at_least"
          doneValue={overall.doneHours}
          targetValue={overall.targetHours}
          met={overall.met}
          markSlot={anyMark}
          missed={overall.missed}
        />
      )}
      {goals.map(({ category, progress }) => (
        <GoalRow
          key={category.id}
          name={category.name}
          done={fmtDuration(progress.doneSeconds)}
          doneTitle={fmtDurationTitle(progress.doneSeconds)}
          target={goalTargetLabel(progress)}
          kind={progress.kind}
          doneValue={progress.doneSeconds}
          targetValue={progress.targetSeconds}
          met={progress.met}
          markSlot={anyMark}
          missed={progress.missed}
          onClick={() => onSelectCategory(category)}
        />
      ))}
    </div>,
    document.body,
  );
}

function GoalRow({
  name,
  done,
  doneTitle,
  target,
  kind,
  doneValue,
  targetValue,
  met,
  missed,
  markSlot,
  onClick,
}: {
  name: string;
  done: string;
  doneTitle?: string;
  target: string;
  kind: GoalKind;
  /** The figures behind `done` and `target`, in one unit, for the bar. */
  doneValue: number;
  targetValue: number;
  met: boolean;
  /** A limit passed or a target missed: the cross in the check's place. */
  missed: boolean;
  /** Keep the mark's width even without one, so the figures of every row
   *  end on the same line whenever any row has a mark. */
  markSlot: boolean;
  onClick?: () => void;
}) {
  const parts = goalBarParts(doneValue, targetValue);
  // Up to the goal: green once a target is reached, accent otherwise. Past
  // it: a fainter green for a target exceeded, warn for a limit passed. The
  // figures stay ink; the bar and the mark carry the verdict.
  const withinColor = kind === "at_least" && met ? "bg-good-data" : "bg-accent";
  const overColor = kind === "at_least" ? "bg-good-data opacity-45" : "bg-warn";
  const body = (
    <>
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        {/* One phrase, "18h of 20h", so a word space apart rather than the
            row's 8px gap, which read as two separate columns. */}
        <span className="flex shrink-0 items-baseline gap-1 tabular-nums">
          <span className="text-ink" title={doneTitle}>{done}</span>
          <span className="text-ink-3-raised">{target}</span>
        </span>
        {met || missed ? <GoalMark missed={missed} limit={kind === "at_most"} /> : markSlot && <span aria-hidden="true" className="w-[9px] shrink-0" />}
      </span>
      {/* Past the goal, the bar spans the time and a gap marks where the goal
          was, so the part beyond it reads as the overrun. */}
      <span aria-hidden="true" className="mt-1.5 flex h-1 gap-[2px] overflow-hidden rounded-full bg-ink-3/20">
        {parts.over > 0 ? (
          <>
            <span className={`block h-full ${withinColor}`} style={{ flex: `${parts.within} 1 0` }} />
            <span className={`block h-full ${overColor}`} style={{ flex: `${parts.over} 1 0` }} />
          </>
        ) : (
          <span className={`block h-full rounded-full ${withinColor}`} style={{ width: `${parts.within * 100}%` }} />
        )}
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={`Narrow Insights to ${name}`}
      className="flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-2 text-xs text-ink-2-raised transition-colors hover:bg-selected-strong focus-visible:bg-selected-strong focus-visible:outline-none"
    >
      {body}
    </button>
  ) : (
    <div className="flex flex-col px-2.5 py-2 text-xs text-ink-2-raised">{body}</div>
  );
}
