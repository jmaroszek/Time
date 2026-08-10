import {
  buildActivityIndex,
  packActivitySource,
  queryActivityIndex,
  type ActivityIndex,
  type ActivityQuery,
  type ActivityQueryResult,
  type ActivitySource,
  type ActivityWorkerRequest,
} from "./activity";
import { createWorkerClient, objectId } from "./workerClient";

const MAX_RESULTS = 12;

export function activitySourceKey(source: ActivitySource): string {
  return `${activitySessionKey(source)}:${activityClassificationKey(source)}`;
}

function activitySessionKey(source: ActivitySource): string {
  return String(objectId(source.sessions));
}

function activityClassificationKey(source: ActivitySource): string {
  return [
    objectId(source.categories),
    objectId(source.rules),
    objectId(source.aliases),
    source.browserProcesses.join(","),
  ].join(":");
}

export function activityRequestKey(source: ActivitySource, query: ActivityQuery): string {
  return `${activitySourceKey(source)}:${JSON.stringify(query)}`;
}

/** The session set the worker already holds, so an unchanged one is not resent.
 *  Cleared whenever the worker goes away, or its next request would assume an
 *  index that no longer exists. */
let workerSessionKey: string | null = null;
/** Index backing the main-thread path, rebuilt only when the source changes. */
let fallbackIndexKey: string | null = null;
let fallbackIndex: ActivityIndex | null = null;

interface ActivityRequest {
  source: ActivitySource;
  query: ActivityQuery;
}

const client = createWorkerClient<ActivityRequest, ActivityQueryResult>({
  maxCached: MAX_RESULTS,
  createWorker: () =>
    new Worker(new URL("../workers/activity.worker.ts", import.meta.url), {
      type: "module",
      name: "time-activity-index",
    }),
  readResult: (data) => (data as typeof data & { result: ActivityQueryResult }).result,
  computeLocally: ({ source, query }) => {
    const sourceKey = activitySourceKey(source);
    if (!fallbackIndex || fallbackIndexKey !== sourceKey) {
      fallbackIndex = buildActivityIndex(source);
      fallbackIndexKey = sourceKey;
    }
    return queryActivityIndex(fallbackIndex, query);
  },
  clearedMessage: "Activity data was refreshed",
  onWorkerLost: () => {
    workerSessionKey = null;
  },
  onClear: () => {
    fallbackIndex = null;
    fallbackIndexKey = null;
    workerSessionKey = null;
  },
  buildMessage: (id, { source, query }) => {
    const sessionKey = activitySessionKey(source);
    const needsSource = workerSessionKey !== sessionKey;
    const packed = needsSource ? packActivitySource(source) : undefined;
    workerSessionKey = sessionKey;
    const message: ActivityWorkerRequest = {
      id,
      sessionKey,
      classificationKey: activityClassificationKey(source),
      source: packed,
      classification: {
        categories: source.categories,
        rules: source.rules,
        browserProcesses: source.browserProcesses,
        aliases: source.aliases,
      },
      query,
    };
    return {
      message,
      transfer: packed
        ? [
            packed.ids.buffer,
            packed.starts.buffer,
            packed.ends.buffer,
            packed.processIndices.buffer,
            packed.titleIndices.buffer,
            packed.domainIndices.buffer,
            packed.isAfk.buffer,
            packed.categoryOverrideIds.buffer,
            packed.isCorrected.buffer,
          ]
        : [],
    };
  },
});

export function peekActivityResult(key: string): ActivityQueryResult | null {
  return client.peek(key);
}

export function analyzeActivity(
  source: ActivitySource,
  query: ActivityQuery,
): Promise<ActivityQueryResult> {
  return client.analyze(activityRequestKey(source, query), { source, query });
}

export function clearActivityAnalysis(): void {
  client.clear();
}
