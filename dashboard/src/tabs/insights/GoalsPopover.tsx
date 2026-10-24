import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { MENU_VIEWPORT_MARGIN } from "../../components/ui";
import { goalTargetLabel, type GoalProgress } from "../../lib/categoryGoals";
import type { Category } from "../../lib/classify";
import { fmtDuration, fmtDurationTitle, fmtWholeHours } from "../../lib/format";
import type { GoalPace } from "../../lib/metrics";
import { GoalMetMark } from "./GoalMetMark";

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
  productiveColor,
  goals,
  onSelectCategory,
  onClose,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  /** Null when no overall goal is set. */
  overall: GoalPace | null;
  productiveColor: string;
  goals: Array<{ category: Category; progress: GoalProgress }>;
  onSelectCategory: (category: Category) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
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
          color={productiveColor}
          done={fmtWholeHours(overall.doneHours)}
          target={`of ${fmtWholeHours(overall.targetHours)}`}
          fraction={overall.fraction}
          met={overall.met}
          over={false}
        />
      )}
      {goals.map(({ category, progress }) => (
        <GoalRow
          key={category.id}
          name={category.name}
          color={category.color}
          done={fmtDuration(progress.doneSeconds)}
          doneTitle={fmtDurationTitle(progress.doneSeconds)}
          target={goalTargetLabel(progress)}
          fraction={progress.fraction}
          met={progress.met}
          over={progress.over}
          onClick={() => onSelectCategory(category)}
        />
      ))}
    </div>,
    document.body,
  );
}

function GoalRow({
  name,
  color,
  done,
  doneTitle,
  target,
  fraction,
  met,
  over,
  onClick,
}: {
  name: string;
  color: string;
  done: string;
  doneTitle?: string;
  target: string;
  fraction: number;
  met: boolean;
  over: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        {met && <GoalMetMark />}
        <span className={`shrink-0 tabular-nums ${over ? "text-warn" : "text-ink"}`} title={doneTitle}>
          {done}
        </span>
        <span className="shrink-0 tabular-nums text-ink-3-raised">{target}</span>
      </span>
      {/* Over its limit, a bar would only say "full"; the colour says by how
          little or much is for the figure. */}
      <span aria-hidden="true" className="ml-[18px] mt-1.5 block h-1 overflow-hidden rounded-full bg-ink-3/20">
        <span
          className={`block h-full rounded-full ${met ? "bg-good-data" : over ? "bg-warn" : "bg-accent"}`}
          style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }}
        />
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={`Narrow Insights to ${name}`}
      className="flex w-full flex-col rounded-lg px-2.5 py-2 text-xs text-ink-2-raised transition-colors hover:bg-selected-strong focus-visible:bg-selected-strong focus-visible:outline-none"
    >
      {body}
    </button>
  ) : (
    <div className="flex flex-col px-2.5 py-2 text-xs text-ink-2-raised">{body}</div>
  );
}
