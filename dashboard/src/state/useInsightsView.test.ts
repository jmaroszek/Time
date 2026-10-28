import { describe, expect, it } from "vitest";

import {
  DEFAULT_INSIGHTS_VIEW,
  launchInsightsView,
  parseStoredInsightsView,
} from "./useInsightsView";

describe("parseStoredInsightsView", () => {
  it("starts on the defaults when nothing is stored", () => {
    expect(parseStoredInsightsView(null)).toEqual(DEFAULT_INSIGHTS_VIEW);
  });

  it("starts on a rolling Week", () => {
    expect(DEFAULT_INSIGHTS_VIEW.preset).toBe("last7");
    expect(DEFAULT_INSIGHTS_VIEW.rolling).toBe(true);
  });

  it("restores every stored choice", () => {
    const stored = {
      preset: "last30",
      rolling: false,
      topN: 20,
      rankedEntityKind: "websites",
      blockMinutes: 0,
      aggregateView: "rhythm",
      metric: "tracked",
      stackBy: "category",
    };
    expect(parseStoredInsightsView(JSON.stringify(stored))).toEqual(stored);
  });

  it("restores Today and All time, which are presets too", () => {
    expect(parseStoredInsightsView(JSON.stringify({ preset: "today" })).preset).toBe("today");
    expect(parseStoredInsightsView(JSON.stringify({ preset: "alltime" })).preset).toBe("alltime");
  });

  it("never restores a custom range", () => {
    expect(parseStoredInsightsView(JSON.stringify({ preset: "custom" })).preset).toBe("last7");
  });

  it("reads a stored view from before the range was remembered", () => {
    const view = parseStoredInsightsView(JSON.stringify({ topN: 20, metric: "tracked" }));
    expect(view.topN).toBe(20);
    expect(view.preset).toBe("last7");
    expect(view.rolling).toBe(true);
  });

  it("drops an unknown value without discarding the rest", () => {
    const view = parseStoredInsightsView(
      JSON.stringify({ topN: 7, stackBy: "category", metric: "sleeping", rolling: "yes" }),
    );
    expect(view.topN).toBe(DEFAULT_INSIGHTS_VIEW.topN);
    expect(view.metric).toBe(DEFAULT_INSIGHTS_VIEW.metric);
    expect(view.rolling).toBe(true);
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

describe("launchInsightsView", () => {
  const stored = parseStoredInsightsView(
    JSON.stringify({ preset: "last30", rolling: false, topN: 20, stackBy: "category" }),
  );

  it("reopens on the stored view when the reader keeps it", () => {
    expect(launchInsightsView(true, stored)).toEqual(stored);
  });

  it("opens on the stock view when the reader turned memory off", () => {
    expect(launchInsightsView(false, stored)).toEqual(DEFAULT_INSIGHTS_VIEW);
  });
});
