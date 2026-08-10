import { useMemo } from "react";

import type { ActivityQuery, ActivityQueryResult, ActivitySource } from "../lib/activity";
import {
  activityRequestKey,
  analyzeActivity,
  peekActivityResult,
} from "../lib/activityClient";
import { useWorkerModel, type WorkerModelOps } from "./useWorkerModel";

export interface ActivityModelData {
  result: ActivityQueryResult | null;
  current: boolean;
  refreshing: boolean;
  error: string | null;
}

interface ActivityRequest {
  source: ActivitySource;
  query: ActivityQuery;
}

const OPS: WorkerModelOps<ActivityRequest, ActivityQueryResult> = {
  key: ({ source, query }) => activityRequestKey(source, query),
  peek: peekActivityResult,
  analyze: ({ source, query }) => analyzeActivity(source, query),
};

export function useActivityModel(
  source: ActivitySource | null,
  query: ActivityQuery | null,
): ActivityModelData {
  // Bundled so the shared hook sees one request value. Memoized on the two
  // identities so the effect re-runs exactly when it did when this hook held
  // `[source, query, …]` in its own dependency list.
  const request = useMemo(
    () => (source && query ? { source, query } : null),
    [source, query],
  );
  return useWorkerModel(request, OPS);
}
