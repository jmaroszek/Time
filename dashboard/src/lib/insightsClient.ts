import {
  buildInsightsModel,
  packInsightsRequestInChunks,
  type InsightsModel,
  type InsightsRequest,
  type InsightsWorkerRequest,
  type InsightsWorkerResponse,
} from "./insights";
import { calendarDays } from "./time";

const MAX_MODELS = 8;

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

export function insightsRequestKey(request: InsightsRequest): string {
  return [
    objectId(request.sessions),
    objectId(request.categories),
    objectId(request.rules),
    request.range.start.getTime(),
    request.range.end.getTime(),
    request.browserProcesses.join(","),
    request.weekStart,
    request.weeklyGoalHours,
    request.minAppSeconds,
    request.focusChainMaxGapSeconds,
    request.dayStartHour,
    request.dayEndHour,
    request.labelMode,
  ].join(":");
}

const modelCache = new Map<string, InsightsModel>();
const pendingByKey = new Map<string, Promise<InsightsModel>>();
let worker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;
const pendingById = new Map<
  number,
  {
    key: string;
    request: InsightsRequest;
    resolve: (model: InsightsModel) => void;
    reject: (error: Error) => void;
  }
>();

function cacheModel(key: string, model: InsightsModel): InsightsModel {
  modelCache.delete(key);
  modelCache.set(key, model);
  while (modelCache.size > MAX_MODELS) {
    const oldest = modelCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    modelCache.delete(oldest);
  }
  return model;
}

export function peekInsightsModel(key: string): InsightsModel | null {
  return modelCache.get(key) ?? null;
}

function buildOnMainThread(key: string, request: InsightsRequest): Promise<InsightsModel> {
  // A worker load/CSP failure must not make Insights unusable. Yield first so
  // the retained prior view and its loading affordance can paint.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(cacheModel(key, buildInsightsModel(request)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);
  });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function disableWorkerAndFallback(): void {
  workerUnavailable = true;
  worker?.terminate();
  worker = null;
  const waiting = [...pendingById.values()];
  pendingById.clear();
  for (const pending of waiting) {
    void buildOnMainThread(pending.key, pending.request).then(pending.resolve, pending.reject);
  }
}

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/insights.worker.ts", import.meta.url), {
      type: "module",
      name: "time-insights-analysis",
    });
    worker.onmessage = (event: MessageEvent<InsightsWorkerResponse>) => {
      const pending = pendingById.get(event.data.id);
      if (!pending) return;
      pendingById.delete(event.data.id);
      if ("error" in event.data) pending.reject(new Error(event.data.error));
      else pending.resolve(cacheModel(pending.key, event.data.model));
    };
    worker.onerror = () => disableWorkerAndFallback();
    worker.onmessageerror = () => disableWorkerAndFallback();
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

export function analyzeInsights(request: InsightsRequest): Promise<InsightsModel> {
  const key = insightsRequestKey(request);
  const cached = modelCache.get(key);
  if (cached) return Promise.resolve(cached);
  const active = pendingByKey.get(key);
  if (active) return active;

  const analysisWorker = getWorker();
  const promise = analysisWorker
    ? new Promise<InsightsModel>((resolve, reject) => {
        const submit = async () => {
          const id = nextRequestId++;
          if (calendarDays(request.range) > 14) {
            const packed = await packInsightsRequestInChunks(request, yieldToBrowser);
            const activeWorker = getWorker();
            if (!activeWorker) {
              void buildOnMainThread(key, request).then(resolve, reject);
              return;
            }
            pendingById.set(id, { key, request, resolve, reject });
            const message: InsightsWorkerRequest = { id, packed };
            activeWorker.postMessage(message, [
              packed.starts.buffer,
              packed.ends.buffer,
              packed.processIndices.buffer,
              packed.categoryIndices.buffer,
              packed.isAfk.buffer,
            ]);
          } else {
            pendingById.set(id, { key, request, resolve, reject });
            const message: InsightsWorkerRequest = { id, request };
            analysisWorker.postMessage(message);
          }
        };
        void submit().catch((error) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      })
    : buildOnMainThread(key, request);
  const tracked = promise.finally(() => {
    if (pendingByKey.get(key) === tracked) pendingByKey.delete(key);
  });
  pendingByKey.set(key, tracked);
  return tracked;
}

export async function warmInsightsModel(request: InsightsRequest): Promise<void> {
  await analyzeInsights(request);
}
