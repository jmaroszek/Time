import { useLayoutEffect, useRef, useState } from "react";

import { tabShortcutLabel } from "../lib/tabShortcuts";

export type Tab = "insights" | "activity" | "settings";

/** Ties the Activity tab to its backlog hint without putting the hint inside
 *  the button, where it would become part of the tab's accessible name. */
const BACKLOG_HINT_ID = "activity-backlog-hint";

/** One sentence, spent twice — as the tab's description and as its tooltip — so
 *  the dot means the same thing however a reader arrives at it. */
const BACKLOG_HINT = "Unclassified activity is waiting";

const TABS: { id: Tab; label: string }[] = [
  { id: "insights", label: "Insights" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

export const TAB_IDS = TABS.map((t) => t.id);

/** Tab switcher whose selected pill slides between tabs instead of jumping. The
 *  pill is one absolutely positioned element measured off the button rects, so it
 *  tracks label widths and font/zoom changes rather than assuming equal tabs. */
export function TabBar({
  tab,
  onTab,
  backlog,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  /** Enough unclassified time to be worth a mark on the Activity tab. */
  backlog: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      const button = buttonRefs.current.get(tab);
      if (!list || !button) return;
      setPill({ left: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [tab]);

  return (
    <div
      ref={listRef}
      className="relative flex items-center gap-1 rounded-xl border border-edge bg-surface p-1"
    >
      {pill && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 bottom-1 rounded-lg bg-selected transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: pill.width, transform: `translateX(${pill.left}px)`, left: 0 }}
        />
      )}
      {TABS.map((t, index) => (
        <button
          key={t.id}
          type="button"
          ref={(node) => {
            if (node) buttonRefs.current.set(t.id, node);
            else buttonRefs.current.delete(t.id);
          }}
          onClick={() => onTab(t.id)}
          className={`relative rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
            tab === t.id ? "text-ink" : "text-ink-2 hover:text-ink"
          }`}
          aria-describedby={t.id === "activity" && backlog ? BACKLOG_HINT_ID : undefined}
          aria-keyshortcuts={`Control+${index + 1}`}
          // The same sentence the hint below carries, for the reader who has
          // neither a screen reader to read it nor any other way to find out
          // what a bare dot means. Every tab's tooltip also names its key, the
          // one place a mouse reader will come across the shortcuts at all.
          title={t.id === "activity" && backlog
            ? `${BACKLOG_HINT} (${tabShortcutLabel(index)})`
            : `${t.label} (${tabShortcutLabel(index)})`}
        >
          {t.label}
          {/* A dot, not a count: the number belongs where you can act on it, and
              the Library's own section carries it. Absolutely positioned so the
              tab keeps its width — a label that grew when the mark appeared
              would shift the tabs beside it and move the sliding pill under the
              cursor that just clicked. */}
          {t.id === "activity" && backlog && (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent"
            />
          )}
        </button>
      ))}
      {/* Described, not renamed. This text sits outside the button on purpose:
          inside it, it would join the accessible name, and a tab that is called
          "Activity" while idle and something longer while work is pending is a
          different control to anyone finding it by name. */}
      {backlog && (
        <span id={BACKLOG_HINT_ID} className="sr-only">
          {BACKLOG_HINT}
        </span>
      )}
    </div>
  );
}
