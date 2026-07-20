import { useEffect, useState } from "react";

import type { InsightsModel, InsightsRequest } from "../lib/insights";
import {
  analyzeInsights,
  insightsRequestKey,
  peekInsightsModel,
} from "../lib/insightsClient";

export interface InsightsModelData {
  /** Current model when ready, otherwise the last completed model. */
  model: InsightsModel | null;
  current: boolean;
  refreshing: boolean;
  error: string | null;
}

interface ModelState {
  key: string | null;
  model: InsightsModel | null;
  error: string | null;
}

export function useInsightsModel(request: InsightsRequest | null): InsightsModelData {
  const key = request ? insightsRequestKey(request) : null;
  const cached = key ? peekInsightsModel(key) : null;
  const [state, setState] = useState<ModelState>({ key: null, model: null, error: null });

  useEffect(() => {
    if (!request || !key) return;
    let cancelled = false;
    if (cached) {
      setState({ key, model: cached, error: null });
      return;
    }
    setState((prior) => ({ ...prior, error: null }));
    void analyzeInsights(request).then(
      (model) => {
        if (!cancelled) setState({ key, model, error: null });
      },
      (error) => {
        if (!cancelled) setState((prior) => ({ ...prior, key, error: String(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, key, cached]);

  if (cached) return { model: cached, current: true, refreshing: false, error: null };
  const current = key !== null && state.key === key && state.error === null;
  return {
    model: state.model,
    current,
    refreshing: request === null || !current,
    error: key !== null && state.key === key ? state.error : null,
  };
}
