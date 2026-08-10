import type { InsightsModel, InsightsRequest } from "../lib/insights";
import {
  analyzeInsights,
  insightsRequestKey,
  peekInsightsModel,
} from "../lib/insightsClient";
import { useWorkerModel, type WorkerModelOps } from "./useWorkerModel";

export interface InsightsModelData {
  /** Current model when ready, otherwise the last completed model. */
  model: InsightsModel | null;
  current: boolean;
  refreshing: boolean;
  error: string | null;
}

const OPS: WorkerModelOps<InsightsRequest, InsightsModel> = {
  key: insightsRequestKey,
  peek: peekInsightsModel,
  analyze: analyzeInsights,
};

export function useInsightsModel(request: InsightsRequest | null): InsightsModelData {
  const { result, current, refreshing, error } = useWorkerModel(request, OPS);
  return { model: result, current, refreshing, error };
}
