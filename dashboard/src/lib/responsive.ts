import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Effective CSS-pixel breakpoints. Keep the matching media queries in
 * index.css in sync; Windows display scaling is already reflected in these
 * viewport measurements. */
export const COMPACT_MAX = 639;
export const MEDIUM_MAX = 1007;
export const WIDE_DETAIL_MIN = 1832;
export const ACTIVITY_COMPACT_TABLE_MAX = 767;
export const MIN_SUPPORTED_WIDTH = 500;
export const MIN_SUPPORTED_HEIGHT = 480;

const ACTIVITY_PANEL_MIN_WIDTH = 300;
const ACTIVITY_PANEL_MAX_WIDTH = 620;
const ACTIVITY_PANEL_GAP = 16;
const ACTIVITY_PANEL_EDGE = 24;

export type LayoutClass = "compact" | "medium" | "large" | "wide-detail";
export type ActivityDetailMode = "drill-in" | "outboard";

export function layoutClass(width: number): LayoutClass {
  if (width <= COMPACT_MAX) return "compact";
  if (width <= MEDIUM_MAX) return "medium";
  if (width < WIDE_DETAIL_MIN) return "large";
  return "wide-detail";
}

export function activityDetailMode(width: number): ActivityDetailMode {
  return width >= WIDE_DETAIL_MIN ? "outboard" : "drill-in";
}

/** Position and width for Activity's outboard inspector. The fixed-width page
 *  keeps its layout while the inspector consumes only the real right margin. */
export function detailPanelBox(viewportWidth: number, cardRight: number): {
  left: number;
  width: number;
} {
  const margin = viewportWidth - (cardRight + ACTIVITY_PANEL_GAP) - ACTIVITY_PANEL_EDGE;
  const width = Math.min(
    ACTIVITY_PANEL_MAX_WIDTH,
    Math.max(ACTIVITY_PANEL_MIN_WIDTH, margin),
  );
  return { left: cardRight + ACTIVITY_PANEL_GAP, width };
}

export type ActivitySummaryColumn = "name" | "comparison" | "time" | "days" | "lastSeen";

export function activitySummaryColumns(width: number): ActivitySummaryColumn[] {
  return width <= ACTIVITY_COMPACT_TABLE_MAX
    ? ["name", "time", "lastSeen"]
    : ["name", "comparison", "time", "days", "lastSeen"];
}

export function activityRowAccessibleLabel({
  name,
  time,
  comparison,
  daysSeen,
  lastSeen,
  action,
}: {
  name: string;
  time: string;
  comparison: string;
  daysSeen: number;
  lastSeen: string;
  action: string;
}): string {
  return `${name} — ${time} — ${comparison} — ${daysSeen} days seen — last seen ${lastSeen} — ${action}`;
}

export function timelineHourInterval(width: number): 3 | 6 {
  return width <= COMPACT_MAX ? 6 : 3;
}

export function rhythmHourInterval(width: number): 1 | 2 | 4 {
  if (width <= COMPACT_MAX) return 4;
  if (width <= MEDIUM_MAX) return 2;
  return 1;
}

export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return width;
}

/** ResizeObserver-backed content width for chart calculations that need the
 * card's actual space rather than the overall window class. */
export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  fallback = MIN_SUPPORTED_WIDTH,
): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(1, node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
