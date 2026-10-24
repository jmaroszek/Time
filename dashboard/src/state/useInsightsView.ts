import { useEffect, useState } from "react";

import type { InsightsScope } from "../lib/insightsScope";
import { ACTIVITY_METRICS, type ActivityMetric, type ActivityStack } from "../lib/overview";

export const TOP_ITEMS_OPTIONS = [5, 10, 15, 20];
export type RankedEntityKind = "apps" | "websites";

/** Defaults for the Insights view controls, used until the reader changes one.
 *  The state lives in App (not OverviewTab) so it survives switching away to
 *  another tab and back — OverviewTab unmounts on a tab switch, App does not. */
const DEFAULT_TOP_ITEMS = TOP_ITEMS_OPTIONS[1]; // Top 10
const DEFAULT_BLOCK_MINUTES = 15;
const DEFAULT_METRIC: ActivityMetric = "productive";
const DEFAULT_STACK_BY: ActivityStack = "state"; // "Productivity"
const BLOCK_MINUTES_OPTIONS = [0, 5, 10, 15, 30];

/** Dashboard-local, like the Categories & Rules list orders: how one person
 *  likes to look at their charts is not part of the tracker contract, and a
 *  setting that resets on every launch read as a bug to the people using it. */
export const INSIGHTS_VIEW_STORAGE_KEY = "time.insights.view";

/** The controls that outlive a launch. Scope is left out on purpose (see
 *  below), and so are the stacks only a narrowed view can show: "member" and
 *  "total" are chosen by the data, never by the reader. */
export interface StoredInsightsView {
  topN: number;
  rankedEntityKind: RankedEntityKind;
  blockMinutes: number;
  aggregateView: "rhythm" | "calendar" | null;
  metric: ActivityMetric;
  stackBy: "state" | "category";
}

export const DEFAULT_INSIGHTS_VIEW: StoredInsightsView = {
  topN: DEFAULT_TOP_ITEMS,
  rankedEntityKind: "apps",
  blockMinutes: DEFAULT_BLOCK_MINUTES,
  aggregateView: null,
  metric: DEFAULT_METRIC,
  stackBy: DEFAULT_STACK_BY,
};

/** Field by field, so a value from an older build — or one an option was since
 *  removed from — falls back alone instead of discarding everything stored. */
export function parseStoredInsightsView(raw: string | null): StoredInsightsView {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Unreadable is the same as absent.
  }
  const pick = <T>(key: keyof StoredInsightsView, allowed: readonly T[]): T =>
    allowed.includes(parsed[key] as T) ? (parsed[key] as T) : (DEFAULT_INSIGHTS_VIEW[key] as T);
  return {
    topN: pick("topN", TOP_ITEMS_OPTIONS),
    rankedEntityKind: pick<RankedEntityKind>("rankedEntityKind", ["apps", "websites"]),
    blockMinutes: pick("blockMinutes", BLOCK_MINUTES_OPTIONS),
    aggregateView: pick<"rhythm" | "calendar" | null>("aggregateView", ["rhythm", "calendar", null]),
    metric: pick("metric", ACTIVITY_METRICS),
    stackBy: pick<"state" | "category">("stackBy", ["state", "category"]),
  };
}

function readStoredInsightsView(): StoredInsightsView {
  try {
    return parseStoredInsightsView(window.localStorage.getItem(INSIGHTS_VIEW_STORAGE_KEY));
  } catch {
    return DEFAULT_INSIGHTS_VIEW;
  }
}

/** Selected timeline resolution, aggregate view, ranked-identity view/count,
 *  calendar metric, and hours-chart stacking — everything the Insights tab lets
 *  you change, remembered across launches. `aggregateView`
 *  starts null so OverviewTab can pin its default the first time a long-enough
 *  range appears. */
export interface InsightsViewState {
  topN: number;
  setTopN: (n: number) => void;
  rankedEntityKind: RankedEntityKind;
  setRankedEntityKind: (kind: RankedEntityKind) => void;
  blockMinutes: number;
  setBlockMinutes: (n: number) => void;
  aggregateView: "rhythm" | "calendar" | null;
  setAggregateView: (
    update:
      | "rhythm"
      | "calendar"
      | null
      | ((current: "rhythm" | "calendar" | null) => "rhythm" | "calendar" | null),
  ) => void;
  metric: ActivityMetric;
  setMetric: (metric: ActivityMetric) => void;
  stackBy: ActivityStack;
  setStackBy: (stack: ActivityStack) => void;
  /** The one app, website, or category the tab is narrowed to; null for all
   *  activity. Kept with the other view controls so leaving for Activity to
   *  curate something and coming back lands on the same subject — but not
   *  persisted, so a fresh launch always opens on everything. */
  scope: InsightsScope | null;
  setScope: (scope: InsightsScope | null) => void;
}

export function useInsightsView(): InsightsViewState {
  const [stored] = useState(readStoredInsightsView);
  const [topN, setTopN] = useState(stored.topN);
  const [rankedEntityKind, setRankedEntityKind] = useState<RankedEntityKind>(stored.rankedEntityKind);
  const [blockMinutes, setBlockMinutes] = useState(stored.blockMinutes);
  const [aggregateView, setAggregateView] = useState<"rhythm" | "calendar" | null>(stored.aggregateView);
  const [metric, setMetric] = useState<ActivityMetric>(stored.metric);
  const [stackBy, setStackBy] = useState<ActivityStack>(stored.stackBy);
  const [scope, setScope] = useState<InsightsScope | null>(null);

  useEffect(() => {
    const next: StoredInsightsView = {
      topN,
      rankedEntityKind,
      blockMinutes,
      aggregateView,
      metric,
      // A narrowed view can force "member" or "total" without the reader
      // asking; only their own choice is worth carrying into the next launch.
      stackBy: stackBy === "category" ? "category" : "state",
    };
    try {
      window.localStorage.setItem(INSIGHTS_VIEW_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // A blocked store costs the next launch its remembered view, nothing more.
    }
  }, [topN, rankedEntityKind, blockMinutes, aggregateView, metric, stackBy]);

  return {
    topN,
    setTopN,
    rankedEntityKind,
    setRankedEntityKind,
    blockMinutes,
    setBlockMinutes,
    aggregateView,
    setAggregateView,
    metric,
    setMetric,
    stackBy,
    setStackBy,
    scope,
    setScope,
  };
}
