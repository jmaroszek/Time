import { describe, expect, it, vi } from "vitest";

import type { Session } from "./metrics";
import { SessionWindowCache } from "./sessionWindowCache";

const session = (id: number, start: number, end: number = start + 10): Session => ({
  id,
  start,
  end,
  process: `app${id}.exe`,
  title: "",
  domain: null,
  isAfk: false,
});

describe("SessionWindowCache", () => {
  it("serves a stable, exact subset from a covering window", async () => {
    const cache = new SessionWindowCache(() => 1_000);
    const fetcher = vi.fn(async () => [session(1, 100), session(2, 200), session(3, 300)]);
    await cache.load(0, 400, fetcher);

    const first = cache.peek(150, 250);
    const second = cache.peek(150, 250);
    expect(first?.sessions.map((row) => row.id)).toEqual([2]);
    expect(second?.sessions).toBe(first?.sessions);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches only a missing edge and de-duplicates its boundary row", async () => {
    const cache = new SessionWindowCache(() => 1_000);
    const fetcher = vi
      .fn<(start: number, end: number) => Promise<Session[]>>()
      .mockResolvedValueOnce([session(2, 200), session(3, 300)])
      .mockResolvedValueOnce([session(1, 100), session(2, 200)]);

    await cache.load(150, 400, fetcher);
    const rows = await cache.load(50, 400, fetcher);

    expect(fetcher.mock.calls).toEqual([[150, 400], [50, 150]]);
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("returns a live-edge hit immediately and refreshes only its tail", async () => {
    let now = 1_000;
    const cache = new SessionWindowCache(() => now, 5);
    const fetcher = vi
      .fn<(start: number, end: number) => Promise<Session[]>>()
      .mockResolvedValueOnce([session(1, 900, 950)])
      .mockResolvedValueOnce([session(1, 900, 1_005), session(2, 1_001, 1_006)]);

    await cache.load(800, 1_100, fetcher);
    now = 1_010;
    expect(cache.peek(800, 1_100)?.stale).toBe(true);
    const rows = await cache.load(800, 1_100, fetcher);

    expect(fetcher.mock.calls[1]).toEqual([950, 1_100]);
    expect(rows.map((row) => [row.id, row.end])).toEqual([[1, 1_005], [2, 1_006]]);
    expect(cache.peek(800, 1_100)?.stale).toBe(false);
  });

  it("drops all reusable data when cleared", async () => {
    const cache = new SessionWindowCache(() => 1_000);
    await cache.load(0, 100, async () => [session(1, 10)]);
    cache.clear();
    expect(cache.peek(0, 100)).toBeNull();
  });

  it("replaces overlapping data on a forced refresh", async () => {
    const cache = new SessionWindowCache(() => 1_000);
    const fetcher = vi
      .fn<(start: number, end: number) => Promise<Session[]>>()
      .mockResolvedValueOnce([session(1, 10)])
      .mockResolvedValueOnce([session(2, 20)]);
    await cache.load(0, 100, fetcher);
    await cache.load(0, 100, fetcher, true);
    expect(cache.peek(0, 100)?.sessions.map((row) => row.id)).toEqual([2]);
  });
});
