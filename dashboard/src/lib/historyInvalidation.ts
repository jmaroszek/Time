import { clearActivityAnalysis } from "./activityClient";
import { clearInsightsModels } from "./insightsClient";
import { clearSessionWindowCache } from "./sessionWindowCache";

type HistoryListener = (revision: number) => void;

let revision = 0;
const listeners = new Set<HistoryListener>();

/** Clear every derived view of session history, then notify mounted consumers
 * so they refetch rather than continuing to render a now-impossible snapshot. */
export function invalidateHistory(): void {
  clearSessionWindowCache();
  clearInsightsModels();
  clearActivityAnalysis();
  revision += 1;
  for (const listener of listeners) listener(revision);
}

export function subscribeHistoryInvalidation(listener: HistoryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentHistoryRevision(): number {
  return revision;
}
