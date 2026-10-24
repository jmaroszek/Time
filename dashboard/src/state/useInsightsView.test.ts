import { describe, expect, it } from "vitest";

import { DEFAULT_INSIGHTS_VIEW, parseStoredInsightsView } from "./useInsightsView";

describe("parseStoredInsightsView", () => {
  it("starts on the defaults when nothing is stored", () => {
    expect(parseStoredInsightsView(null)).toEqual(DEFAULT_INSIGHTS_VIEW);
  });

  it("restores every stored choice", () => {
    const stored = {
      topN: 20,
      rankedEntityKind: "websites",
      blockMinutes: 0,
      aggregateView: "rhythm",
      metric: "tracked",
      stackBy: "category",
    };
    expect(parseStoredInsightsView(JSON.stringify(stored))).toEqual(stored);
  });

  it("drops an unknown value without discarding the rest", () => {
    const view = parseStoredInsightsView(
      JSON.stringify({ topN: 7, stackBy: "category", metric: "sleeping" }),
    );
    expect(view.topN).toBe(DEFAULT_INSIGHTS_VIEW.topN);
    expect(view.metric).toBe(DEFAULT_INSIGHTS_VIEW.metric);
    expect(view.stackBy).toBe("category");
  });

  it("never restores a stack only a narrowed view can choose", () => {
    expect(parseStoredInsightsView(JSON.stringify({ stackBy: "member" })).stackBy).toBe("state");
    expect(parseStoredInsightsView(JSON.stringify({ stackBy: "total" })).stackBy).toBe("state");
  });

  it("treats unreadable or non-object storage as absent", () => {
    expect(parseStoredInsightsView("{not json")).toEqual(DEFAULT_INSIGHTS_VIEW);
    expect(parseStoredInsightsView("[1,2]")).toEqual(DEFAULT_INSIGHTS_VIEW);
    expect(parseStoredInsightsView("null")).toEqual(DEFAULT_INSIGHTS_VIEW);
  });
});
