import { useEffect, useState } from "react";

import type { ActivityQuery, ActivityQueryResult, ActivitySource } from "../lib/activity";
import {
  activityRequestKey,
  analyzeActivity,
  peekActivityResult,
} from "../lib/activityClient";

export interface ActivityModelData {
  result: ActivityQueryResult | null;
  current: boolean;
  refreshing: boolean;
  error: string | null;
}

interface ActivityState {
  key: string | null;
  result: ActivityQueryResult | null;
  error: string | null;
}

export function useActivityModel(
  source: ActivitySource | null,
  query: ActivityQuery | null,
): ActivityModelData {
  const key = source && query ? activityRequestKey(source, query) : null;
  const cached = key ? peekActivityResult(key) : null;
  const [state, setState] = useState<ActivityState>({ key: null, result: null, error: null });

  useEffect(() => {
    if (!source || !query || !key) return;
    let cancelled = false;
    if (cached) {
      setState({ key, result: cached, error: null });
      return;
    }
    setState((prior) => ({ ...prior, error: null }));
    void analyzeActivity(source, query).then(
      (result) => {
        if (!cancelled) setState({ key, result, error: null });
      },
      (error) => {
        if (!cancelled) setState((prior) => ({ ...prior, key, error: String(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, query, key, cached]);

  if (cached) return { result: cached, current: true, refreshing: false, error: null };
  const current = key !== null && state.key === key && state.error === null;
  return {
    result: state.result,
    current,
    refreshing: !current,
    error: key !== null && state.key === key ? state.error : null,
  };
}
