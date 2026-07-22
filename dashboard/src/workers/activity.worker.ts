import {
  buildActivityIndex,
  queryActivityIndex,
  unpackActivitySource,
  type ActivityIndex,
  type ActivityWorkerRequest,
  type ActivityWorkerResponse,
} from "../lib/activity";

let sessionKey: string | null = null;
let classificationKey: string | null = null;
let sessions: ReturnType<typeof unpackActivitySource>["sessions"] | null = null;
let index: ActivityIndex | null = null;

self.onmessage = (event: MessageEvent<ActivityWorkerRequest>) => {
  let response: ActivityWorkerResponse;
  try {
    if (event.data.source) {
      sessions = unpackActivitySource(event.data.source).sessions;
      sessionKey = event.data.sessionKey;
      index = null;
      classificationKey = null;
    }
    if (!sessions || sessionKey !== event.data.sessionKey) {
      throw new Error("Activity worker source is not initialized");
    }
    if (!index || classificationKey !== event.data.classificationKey) {
      index = buildActivityIndex({ sessions, ...event.data.classification });
      classificationKey = event.data.classificationKey;
    }
    response = {
      id: event.data.id,
      result: queryActivityIndex(index, event.data.query),
    };
  } catch (error) {
    response = {
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(response);
};
