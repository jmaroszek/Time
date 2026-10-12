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
  it("reconciles an active row shortened beyond the lookback by AFK detection", async () => {
    let now = 1290;
    const cache = new SessionWindowCache(() => now);
    let rows = [session(1, 900, 1290)];
    const fetcher = vi.fn(async (start: number, end: number) =>
      rows.filter((row) => row.end > start && row.start < end));
    await cache.load(800, 1400, fetcher);
    rows = [session(1, 900, 1000), { ...session(2, 1000, 1315), isAfk: true }];
    now = 1315;
    const refreshed = await cache.load(800, 1400, fetcher);
    expect(refreshed).toEqual(rows);
    expect(refreshed.filter((row) => !row.isAfk)
      .reduce((seconds, row) => seconds + row.end - row.start, 0)).toBe(100);
    expect(cache.peek(950, 1050)?.sessions).toEqual(rows);
  });

  it.each([0, 1000])("removes a shortened row no longer overlapping the cached window (%s)", async (end) => {
    let now = 1290;
    const cache = new SessionWindowCache(() => now);
    let rows = [session(1, 0, 1290)];
    const fetcher = async (start: number, stop: number) =>
      rows.filter((row) => row.end > start && row.start < stop);
    await cache.load(1100, 1400, fetcher);
    rows = [session(1, 0, end), { ...session(2, end, 1315), isAfk: true }];
    now = 1315;
    expect(await cache.load(1100, 1400, fetcher)).toEqual([rows[1]]);
  });

  it("keeps all overlapping legacy rows across the left edge", async () => {
    const cache = new SessionWindowCache(() => 5000);
    const rows = [session(1, 0, 1500), session(2, 1000, 1299),
      { ...session(3, 1000, 1301), isAfk: true }];
    expect(await cache.load(1100, 1200, async () => rows)).toEqual(rows);
    expect(cache.peek(1150, 1160)?.sessions).toEqual(rows);
  });

  it("does not overwrite a newer refresh when an older fetch finishes last", async () => {
    let now = 1290;
    const cache = new SessionWindowCache(() => now);
    await cache.load(800, 1400, async () => [session(1, 900, 1290)]);
    now = 1310;
    let finish!: (rows: Session[]) => void;
    const old = cache.load(800, 1400, () => new Promise((resolve) => { finish = resolve; }));
    now = 1320;
    const current = [session(1, 900, 1000), { ...session(2, 1000, 1320), isAfk: true }];
    await cache.load(800, 1500, async () => current);
    finish([session(1, 900, 1290)]);
    expect(await old).toEqual(current);
    expect(cache.peek(800, 1400)?.sessions).toEqual(current);
  });

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

  it("keeps a long session that starts before the requested range", async () => {
    const cache = new SessionWindowCache(() => 1_000);
    await cache.load(100, 200, async () => [session(1, -1_000_000, 150), session(2, 150, 160)]);

    expect(cache.peek(100, 200)?.sessions.map((row) => row.id)).toEqual([1, 2]);
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

    // Include the last recorded row, whose end may move backwards on idle.
    expect(fetcher.mock.calls[1]).toEqual([900, 1_100]);
    expect(rows.map((row) => [row.id, row.end])).toEqual([[1, 1_005], [2, 1_006]]);
    expect(cache.peek(800, 1_100)?.stale).toBe(false);
  });

  it("refetches the whole skipped span, not a fixed recent slice", async () => {
    let now = 1_000;
    const cache = new SessionWindowCache(() => now, 5);
    // Opened and closed entirely within the gap: it overlaps neither the
    // original window's contents nor the last minute before the refresh, so a
    // constant-width tail refresh could never see it.
    const missed = session(2, 3_000, 3_400);
    const fetcher = vi
      .fn<(start: number, end: number) => Promise<Session[]>>()
      .mockResolvedValueOnce([session(1, 900, 950)])
      .mockResolvedValueOnce([session(1, 900, 950), missed]);

    await cache.load(800, 90_000, fetcher);
    now = 5_000; // an hour of the app sitting open on one tab
    const rows = await cache.load(800, 90_000, fetcher);

    expect(fetcher.mock.calls[1]).toEqual([900, 90_000]);
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it("drops all reusable data when cleared", async () => {
    const cache = new SessionWindowCache(() => 1_000);
    await cache.load(0, 100, async () => [session(1, 10)]);
    cache.clear();
    expect(cache.peek(0, 100)).toBeNull();
  });

  it("refreshes the existing live tail when expanding the end", async () => {
    let now = 1_000;
    const cache = new SessionWindowCache(() => now);
    let rows = [session(1, 900, 950)];
    const fetcher = vi.fn(async (start: number, end: number) =>
      rows.filter((row) => row.end > start && row.start < end));
    await cache.load(800, 1_100, fetcher);
    now = 1_010;
    rows = [...rows, session(2, 1_001, 1_006)];

    expect((await cache.load(800, 1_200, fetcher)).map((row) => row.id)).toEqual([1, 2]);
    expect(fetcher.mock.calls).toEqual([[800, 1_100], [900, 1_200]]);
    expect(cache.peek(800, 1_200)?.stale).toBe(false);
  });

  it("finishes a formerly live window before treating it as historical", async () => {
    let now = 1_000;
    const cache = new SessionWindowCache(() => now);
    const fetcher = vi.fn<(start: number, end: number) => Promise<Session[]>>()
      .mockResolvedValueOnce([session(1, 900, 950)])
      .mockResolvedValueOnce([session(1, 900, 950), session(2, 1_001, 1_006)]);
    await cache.load(800, 1_100, fetcher);
    now = 1_300;
    expect(cache.peek(800, 1_100)?.stale).toBe(true);
    expect((await cache.load(800, 1_100, fetcher)).map((row) => row.id)).toEqual([1, 2]);
    now = 2_000;
    await cache.load(800, 1_100, fetcher);
    expect(fetcher.mock.calls).toEqual([[800, 1_100], [900, 1_100]]);
    expect(cache.peek(800, 1_100)?.stale).toBe(false);
  });

  it("does not certify unfetched portions of an entry after refreshing a subset", async () => {
    let now = 1_000;
    const cache = new SessionWindowCache(() => now);
    let rows = [session(1, 900, 950)];
    const fetcher = vi.fn(async (start: number, end: number) =>
      rows.filter((row) => row.end > start && row.start < end));
    await cache.load(800, 2_000, fetcher);
    now = 1_500;
    rows = [...rows, session(2, 1_001, 1_006), session(3, 1_300, 1_400)];
    await cache.load(1_200, 1_450, fetcher);
    expect(cache.peek(800, 2_000)?.sessions.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(fetcher.mock.calls[1]).toEqual([900, 2_000]);
  });

  it("does not count time spent fetching as already refreshed", async () => {
    let now = 1_000;
    const cache = new SessionWindowCache(() => now);
    await cache.load(800, 2_000, async () => {
      now = 1_010;
      return [session(1, 900, 950)];
    });
    expect(cache.peek(800, 2_000)?.stale).toBe(true);
  });

  it("does not let a deferred fetch repopulate after clear", async () => {
    let resolveFetch!: (rows: Session[]) => void;
    const deferred = new Promise<Session[]>((resolve) => {
      resolveFetch = resolve;
    });
    const cache = new SessionWindowCache(() => 1_000);
    const staleLoad = cache.load(0, 100, () => deferred);

    cache.clear();
    resolveFetch([session(1, 10)]);
    await staleLoad;

    expect(cache.peek(0, 100)).toBeNull();
    const freshFetcher = vi.fn(async () => [session(2, 20)]);
    await cache.load(0, 100, freshFetcher);
    expect(freshFetcher).toHaveBeenCalledOnce();
    expect(cache.peek(0, 100)?.sessions.map((row) => row.id)).toEqual([2]);
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
