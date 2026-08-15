import {
  buildInsightsModel,
  packInsightsRequestInChunks,
  type InsightsModel,
  type InsightsRequest,
  type InsightsWorkerRequest,
} from "./insights";
import { calendarDays } from "./time";
import { createWorkerClient, objectId } from "./workerClient";

const MAX_MODELS = 8;

/** Ranges longer than this are packed into transferable chunks rather than
 *  structured-cloned whole, which blocks the main thread at this size. */
const CHUNKED_PACK_MIN_DAYS = 14;

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
    request.minAppSecondsPerDay,
    objectId(request.aliases),
    request.focusChainMaxGapSeconds,
    request.hideUtilityApps,
    request.dayStartHour,
    request.dayEndHour,
    request.labelMode,
    request.firstObservedSec,
    request.analysisCutoffSec,
  ].join(":");
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

const client = createWorkerClient<InsightsRequest, InsightsModel>({
  maxCached: MAX_MODELS,
  createWorker: () =>
    new Worker(new URL("../workers/insights.worker.ts", import.meta.url), {
      type: "module",
      name: "time-insights-analysis",
    }),
  readResult: (data) => (data as typeof data & { model: InsightsModel }).model,
  computeLocally: buildInsightsModel,
  clearedMessage: "Insights data was refreshed",
  // Deliberately not an `async` function: a short range posts synchronously,
  // and only the chunked path returns a promise. Marking the whole thing async
  // would push every request onto a microtask for no reason.
  buildMessage: (id, request) => {
    if (calendarDays(request.range) > CHUNKED_PACK_MIN_DAYS) {
      return packInsightsRequestInChunks(request, yieldToBrowser).then((packed) => ({
        message: { id, packed } satisfies InsightsWorkerRequest,
        transfer: [
          packed.starts.buffer,
          packed.ends.buffer,
          packed.processIndices.buffer,
          packed.domainIndices.buffer,
          packed.categoryIndices.buffer,
          packed.isAfk.buffer,
        ],
      }));
    }
    return { message: { id, request } satisfies InsightsWorkerRequest };
  },
});

export function peekInsightsModel(key: string): InsightsModel | null {
  return client.peek(key);
}

export function analyzeInsights(request: InsightsRequest): Promise<InsightsModel> {
  return client.analyze(insightsRequestKey(request), request);
}

export async function warmInsightsModel(request: InsightsRequest): Promise<void> {
  await analyzeInsights(request);
}

export function clearInsightsModels(): void {
  client.clear();
}
