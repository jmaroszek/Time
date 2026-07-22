import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearSessions, clearInsights, clearActivity } = vi.hoisted(() => ({
  clearSessions: vi.fn(),
  clearInsights: vi.fn(),
  clearActivity: vi.fn(),
}));

vi.mock("./sessionWindowCache", () => ({ clearSessionWindowCache: clearSessions }));
vi.mock("./insightsClient", () => ({ clearInsightsModels: clearInsights }));
vi.mock("./activityClient", () => ({ clearActivityAnalysis: clearActivity }));

import {
  currentHistoryRevision,
  invalidateHistory,
  subscribeHistoryInvalidation,
} from "./historyInvalidation";

describe("history invalidation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears every history cache and forces subscribed consumers to refresh", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHistoryInvalidation(listener);
    const before = currentHistoryRevision();
    invalidateHistory();

    expect(clearSessions).toHaveBeenCalledOnce();
    expect(clearInsights).toHaveBeenCalledOnce();
    expect(clearActivity).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(before + 1);

    unsubscribe();
    invalidateHistory();
    expect(listener).toHaveBeenCalledOnce();
  });
});
