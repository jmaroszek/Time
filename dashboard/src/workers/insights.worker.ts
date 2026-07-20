import {
  buildInsightsModel,
  buildInsightsModelFromPacked,
  type InsightsWorkerRequest,
  type InsightsWorkerResponse,
} from "../lib/insights";

self.onmessage = (event: MessageEvent<InsightsWorkerRequest>) => {
  let response: InsightsWorkerResponse;
  try {
    const model = "packed" in event.data
      ? buildInsightsModelFromPacked(event.data.packed)
      : buildInsightsModel(event.data.request);
    response = { id: event.data.id, model };
  } catch (error) {
    response = { id: event.data.id, error: String(error) };
  }
  self.postMessage(response);
};

export {};
