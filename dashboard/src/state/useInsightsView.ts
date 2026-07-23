import { useState } from "react";

import type { ActivityMetric, ActivityStack } from "../lib/overview";

export const TOP_APPS_OPTIONS = [5, 10, 15, 20];

/** Launch defaults for the Insights view controls. These are the values every
 *  fresh app session starts on; a change made in the UI overrides them until the
 *  next reload. The state lives in App (not OverviewTab) so it survives switching
 *  away to another tab and back — OverviewTab unmounts on a tab switch, App does
 *  not. */
const DEFAULT_TOP_APPS = TOP_APPS_OPTIONS[1]; // Top 10
const DEFAULT_BLOCK_MINUTES = 15;
const DEFAULT_METRIC: ActivityMetric = "productive";
const DEFAULT_STACK_BY: ActivityStack = "state"; // "Productivity"

/** Selected timeline resolution, aggregate view, top-app count, calendar metric,
 *  and hours-chart stacking — everything the Insights tab lets you change and
 *  should remember for the rest of the session. `aggregateView` starts null so
 *  OverviewTab can pin its default the first time a long-enough range appears. */
export interface InsightsViewState {
  topN: number;
  setTopN: (n: number) => void;
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
}

export function useInsightsView(): InsightsViewState {
  const [topN, setTopN] = useState(DEFAULT_TOP_APPS);
  const [blockMinutes, setBlockMinutes] = useState(DEFAULT_BLOCK_MINUTES);
  const [aggregateView, setAggregateView] = useState<"rhythm" | "calendar" | null>(null);
  const [metric, setMetric] = useState<ActivityMetric>(DEFAULT_METRIC);
  const [stackBy, setStackBy] = useState<ActivityStack>(DEFAULT_STACK_BY);

  return {
    topN,
    setTopN,
    blockMinutes,
    setBlockMinutes,
    aggregateView,
    setAggregateView,
    metric,
    setMetric,
    stackBy,
    setStackBy,
  };
}
