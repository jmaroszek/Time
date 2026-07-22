import {
  buildActivityIndex,
  packActivitySource,
  queryActivityIndex,
  type ActivityIndex,
  type ActivityQuery,
  type ActivityQueryResult,
  type ActivitySource,
  type ActivityWorkerRequest,
  type ActivityWorkerResponse,
} from "./activity";

const MAX_RESULTS = 12;

let nextObjectId = 1;
const objectIds = new WeakMap<object, number>();
function objectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
}

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

const resultCache = new Map<string, ActivityQueryResult>();
const pendingByKey = new Map<string, Promise<ActivityQueryResult>>();
let worker: Worker | null = null;
let workerUnavailable = false;
let workerSessionKey: string | null = null;
let fallbackIndexKey: string | null = null;
let fallbackIndex: ActivityIndex | null = null;
let nextRequestId = 1;

const pendingById = new Map<number, {
  key: string;
  source: ActivitySource;
  query: ActivityQuery;
  resolve: (result: ActivityQueryResult) => void;
  reject: (error: Error) => void;
}>();

function cacheResult(key: string, result: ActivityQueryResult): ActivityQueryResult {
  resultCache.delete(key);
  resultCache.set(key, result);
  while (resultCache.size > MAX_RESULTS) {
    const oldest = resultCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
  return result;
}

export function peekActivityResult(key: string): ActivityQueryResult | null {
  return resultCache.get(key) ?? null;
}

function buildOnMainThread(
  key: string,
  source: ActivitySource,
  query: ActivityQuery,
): Promise<ActivityQueryResult> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const sourceKey = activitySourceKey(source);
        if (!fallbackIndex || fallbackIndexKey !== sourceKey) {
          fallbackIndex = buildActivityIndex(source);
          fallbackIndexKey = sourceKey;
        }
        resolve(cacheResult(key, queryActivityIndex(fallbackIndex, query)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);
  });
}

function disableWorkerAndFallback(): void {
  workerUnavailable = true;
  worker?.terminate();
  worker = null;
  workerSessionKey = null;
  const waiting = [...pendingById.values()];
  pendingById.clear();
  for (const pending of waiting) {
    void buildOnMainThread(pending.key, pending.source, pending.query).then(
      pending.resolve,
      pending.reject,
    );
  }
}

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/activity.worker.ts", import.meta.url), {
      type: "module",
      name: "time-activity-index",
    });
    worker.onmessage = (event: MessageEvent<ActivityWorkerResponse>) => {
      const pending = pendingById.get(event.data.id);
      if (!pending) return;
      pendingById.delete(event.data.id);
      if ("error" in event.data) pending.reject(new Error(event.data.error));
      else pending.resolve(cacheResult(pending.key, event.data.result));
    };
    worker.onerror = () => disableWorkerAndFallback();
    worker.onmessageerror = () => disableWorkerAndFallback();
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

export function analyzeActivity(
  source: ActivitySource,
  query: ActivityQuery,
): Promise<ActivityQueryResult> {
  const key = activityRequestKey(source, query);
  const cached = resultCache.get(key);
  if (cached) return Promise.resolve(cached);
  const active = pendingByKey.get(key);
  if (active) return active;

  const activityWorker = getWorker();
  const promise = activityWorker
    ? new Promise<ActivityQueryResult>((resolve, reject) => {
        try {
          const id = nextRequestId++;
          const sessionKey = activitySessionKey(source);
          const classificationKey = activityClassificationKey(source);
          const needsSource = workerSessionKey !== sessionKey;
          const packed = needsSource ? packActivitySource(source) : undefined;
          workerSessionKey = sessionKey;
          pendingById.set(id, { key, source, query, resolve, reject });
          const message: ActivityWorkerRequest = {
            id,
            sessionKey,
            classificationKey,
            source: packed,
            classification: {
              categories: source.categories,
              rules: source.rules,
              browserProcesses: source.browserProcesses,
              aliases: source.aliases,
            },
            query,
          };
          activityWorker.postMessage(
            message,
            packed
              ? [
                  packed.ids.buffer,
                  packed.starts.buffer,
                  packed.ends.buffer,
                  packed.processIndices.buffer,
                  packed.titleIndices.buffer,
                  packed.domainIndices.buffer,
                  packed.isAfk.buffer,
                ]
              : [],
          );
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })
    : buildOnMainThread(key, source, query);

  const tracked = promise.finally(() => {
    if (pendingByKey.get(key) === tracked) pendingByKey.delete(key);
  });
  pendingByKey.set(key, tracked);
  return tracked;
}

export function clearActivityAnalysis(): void {
  const error = new Error("Activity data was refreshed");
  for (const pending of pendingById.values()) pending.reject(error);
  resultCache.clear();
  pendingByKey.clear();
  fallbackIndex = null;
  fallbackIndexKey = null;
  workerSessionKey = null;
  worker?.terminate();
  worker = null;
  pendingById.clear();
}
