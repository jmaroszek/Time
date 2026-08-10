import { useEffect } from "react";

import type { InsightsRequest } from "../lib/insights";
import { warmInsightsModel } from "../lib/insightsClient";
import { fetchSessions } from "../lib/queries";
import { loadSessionWindow } from "../lib/sessionWindowCache";
import {
  addDays,
  allTimeRange,
  previousRange,
  rangeForPreset,
  type Range,
} from "../lib/time";

export function insightsFetchWindow(range: Range): { startSec: number; endSec: number } {
  const previous = previousRange(range);
  return {
    startSec: Math.min(previous.start.getTime(), addDays(range.start, -6).getTime()) / 1000,
    endSec: range.end.getTime() / 1000,
  };
}

/** Warm nested ordinary presets once the model on screen is complete. */
export function useInsightsWarmup(
  request: InsightsRequest | null,
  current: boolean,
  firstSessionSec: number | null,
): void {
  useEffect(() => {
    if (!request || !current) return;
    const yearRange = rangeForPreset("last365");
    const yearWindow = insightsFetchWindow(yearRange);
    let cancelled = false;
    const warm = () => {
      void (async () => {
        await loadSessionWindow(yearWindow.startSec, yearWindow.endSec, fetchSessions);
        if (cancelled) return;
        for (const warmRange of [
          rangeForPreset("last30"),
          rangeForPreset("last90"),
          yearRange,
        ]) {
          const warmWindow = insightsFetchWindow(warmRange);
          const sessions = await loadSessionWindow(
            warmWindow.startSec,
            warmWindow.endSec,
            fetchSessions,
          );
          if (cancelled) return;
          await warmInsightsModel({
            ...request,
            sessions,
            range: warmRange,
            labelMode: "date",
          });
        }

        if (firstSessionSec !== null) {
          const allRange = allTimeRange(firstSessionSec);
          const allWindow = insightsFetchWindow(allRange);
          if (allWindow.startSec < yearWindow.startSec) return;
          const allSessions = await loadSessionWindow(
            allWindow.startSec,
            allWindow.endSec,
            fetchSessions,
          );
          if (cancelled) return;
          await warmInsightsModel({
            ...request,
            sessions: allSessions,
            range: allRange,
            labelMode: "date",
          });
        }
      })().catch(() => {});
    };
    const idle = window.requestIdleCallback?.(warm, { timeout: 3_000 });
    const timeout = idle === undefined ? window.setTimeout(warm, 500) : null;
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [request, current, firstSessionSec]);
}
