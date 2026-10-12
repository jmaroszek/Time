import type { Session } from "./metrics";

const LIVE_EDGE_GRACE_SEC = 120;
const DEFAULT_FRESH_FOR_SEC = 5;
const DEFAULT_MAX_ENTRIES = 2;
/** Slack subtracted from the last refresh time before refetching the live edge.
 *  Absorbs clock skew and the gap between a session opening and its row landing;
 *  it is not the width of the refresh, which is measured from that last refresh. */
const LIVE_REFRESH_LOOKBACK_SEC = 60;

export type SessionFetcher = (startSec: number, endSec: number) => Promise<Session[]>;

export interface SessionCacheHit {
  sessions: Session[];
  stale: boolean;
}

interface CacheEntry {
  startSec: number;
  endSec: number;
  sessions: Session[];
  maxEnds: number[];
  refreshedAtSec: number;
  lastUsed: number;
  version: number;
  slices: Map<string, { version: number; sessions: Session[] }>;
}

function sameSession(left: Session, right: Session): boolean {
  return (
    left.id === right.id &&
    left.start === right.start &&
    left.end === right.end &&
    left.process === right.process &&
    left.title === right.title &&
    left.domain === right.domain &&
    left.isAfk === right.isAfk &&
    left.categoryOverrideId === right.categoryOverrideId &&
    left.isCorrected === right.isCorrected
  );
}

function upperBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => a.start - b.start || a.id - b.id);
}

function maximumEnds(sessions: Session[]): number[] {
  let end = -Infinity;
  return sessions.map((session) => (end = Math.max(end, session.end)));
}

function overlappingSessions(
  sessions: Session[], startSec: number, endSec: number,
  maxEnds = maximumEnds(sessions),
): Session[] {
  // Older recordings can contain overlaps. Prefix maxima preserve every row
  // crossing the left edge while keeping ordinary cache slices logarithmic.
  const first = upperBound(maxEnds, startSec);
  const out: Session[] = [];
  for (let index = first; index < sessions.length; index++) {
    const session = sessions[index];
    if (session.start >= endSec) break;
    if (session.end > startSec) out.push(session);
  }
  return out;
}

/**
 * A small in-memory union of recently fetched session windows.
 *
 * Duration presets overlap heavily. Expanding a cached window fetches only the
 * missing edge, while narrowing uses a binary-searched slice. Near the live
 * edge, a short overlapping refresh picks up new rows and a tracker-updated
 * tail without making an otherwise cached switch wait for the database.
 */
export class SessionWindowCache {
  private readonly entries: CacheEntry[] = [];
  private readonly pending = new Map<string, Promise<Session[]>>();
  private useCounter = 0;
  private generation = 0;

  constructor(
    private readonly nowSec: () => number = () => Date.now() / 1000,
    private readonly freshForSec = DEFAULT_FRESH_FOR_SEC,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  clear(): void {
    this.generation += 1;
    this.entries.length = 0;
    this.pending.clear();
  }

  peek(startSec: number, endSec: number): SessionCacheHit | null {
    const entry = this.coveringEntry(startSec, endSec);
    if (!entry) return null;
    entry.lastUsed = ++this.useCounter;
    return {
      sessions: this.slice(entry, startSec, endSec),
      stale: this.needsLiveRefresh(entry, endSec),
    };
  }

  load(
    startSec: number,
    endSec: number,
    fetcher: SessionFetcher,
    forceRefresh = false,
  ): Promise<Session[]> {
    if (!(endSec > startSec)) return Promise.resolve([]);
    const key = `${startSec}:${endSec}:${forceRefresh ? 1 : 0}`;
    const active = this.pending.get(key);
    if (active) return active;
    const generation = this.generation;

    const promise = this.loadUnshared(startSec, endSec, fetcher, forceRefresh, generation).finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  private async loadUnshared(
    startSec: number,
    endSec: number,
    fetcher: SessionFetcher,
    forceRefresh: boolean,
    generation: number,
  ): Promise<Session[]> {
    // Freshness describes the snapshot requested, not when a slow fetch happens
    // to finish. Rows recorded while the query is in flight still need a refresh.
    const fetchedAtSec = this.nowSec();
    if (forceRefresh) {
      const sessions = sortSessions(await fetcher(startSec, endSec));
      if (generation !== this.generation) {
        return overlappingSessions(sessions, startSec, endSec);
      }
      for (let index = this.entries.length - 1; index >= 0; index--) {
        const existing = this.entries[index];
        if (Math.min(existing.endSec, endSec) > Math.max(existing.startSec, startSec)) {
          this.entries.splice(index, 1);
        }
      }
      const replacement: CacheEntry = {
        startSec,
        endSec,
        sessions,
        maxEnds: maximumEnds(sessions),
        refreshedAtSec: fetchedAtSec,
        lastUsed: ++this.useCounter,
        version: 1,
        slices: new Map(),
      };
      this.entries.push(replacement);
      this.evictOldEntries(replacement);
      return this.slice(replacement, startSec, endSec);
    }

    let entry = this.coveringEntry(startSec, endSec);
    if (entry && !this.needsLiveRefresh(entry, endSec)) {
      entry.lastUsed = ++this.useCounter;
      return this.slice(entry, startSec, endSec);
    }

    if (!entry) entry = this.bestOverlappingEntry(startSec, endSec);
    if (!entry) {
      const sessions = sortSessions(await fetcher(startSec, endSec));
      if (generation !== this.generation) {
        return overlappingSessions(sessions, startSec, endSec);
      }
      entry = {
        startSec,
        endSec,
        sessions,
        maxEnds: maximumEnds(sessions),
        refreshedAtSec: fetchedAtSec,
        lastUsed: ++this.useCounter,
        version: 1,
        slices: new Map(),
      };
      this.entries.push(entry);
      this.evictOldEntries(entry);
      return this.slice(entry, startSec, endSec);
    }

    const oldStart = entry.startSec;
    const oldEnd = entry.endSec;
    const oldVersion = entry.version;
    const segments: Array<[number, number]> = [];
    if (startSec < oldStart) segments.push([startSec, Math.min(oldStart, endSec)]);
    if (endSec > oldEnd) segments.push([Math.max(oldEnd, startSec), endSec]);

    const refreshLiveEdge = this.needsLiveRefresh(entry, oldEnd)
      || (endSec > oldEnd
        && oldEnd >= Math.min(fetchedAtSec, entry.refreshedAtSec) - LIVE_EDGE_GRACE_SEC);
    if (refreshLiveEdge) {
      const refreshEnd = oldEnd;
      // Refetch back to the last refresh, not a fixed slice of the recent past.
      // A constant window silently lost history: nothing starts a fetch while a
      // tab sits open, so an entry could go an hour without refreshing and then
      // pick up only the last minute of it. Sessions that opened *and* closed
      // inside that hour never overlapped the refetched slice, so they stayed
      // missing until an invalidation or a restart. Measuring from
      // refreshedAtSec makes the cost proportional to the time actually skipped.
      const refreshedAtSec = Math.min(entry.refreshedAtSec, this.nowSec());
      // Refresh the entry's whole unfinished tail, even when the caller asks
      // for a subset. One freshness timestamp must never certify unfetched rows.
      // The most recently recorded row can shrink all the way to its start
      // when AFK is detected. Refetch it even if its new end leaves the usual
      // lookback. IDs reflect recording order even when corrections move times.
      const latest = entry.sessions.reduce<Session | undefined>(
        (last, row) => !last || row.id > last.id ? row : last, undefined,
      );
      const refreshStart = Math.max(oldStart, Math.min(
        refreshedAtSec - LIVE_REFRESH_LOOKBACK_SEC, latest?.start ?? Infinity,
      ));
      if (refreshEnd > refreshStart) segments.push([refreshStart, refreshEnd]);
    }

    // Expansion and refresh can touch. Coalesce them into one query per edge.
    segments.sort((left, right) => left[0] - right[0]);
    const windows: Array<[number, number]> = [];
    for (const segment of segments) {
      const previous = windows[windows.length - 1];
      if (previous && segment[0] <= previous[1]) previous[1] = Math.max(previous[1], segment[1]);
      else windows.push([...segment]);
    }
    const fetched = await Promise.all(windows.map(([from, to]) => fetcher(from, to)));
    if (generation !== this.generation) {
      return overlappingSessions(sortSessions(fetched.flat()), startSec, endSec);
    }
    if (entry.version !== oldVersion) {
      // Another window refreshed this entry while we fetched. Re-evaluate
      // coverage instead of replacing newer rows with an older query result.
      return this.loadUnshared(startSec, endSec, fetcher, false, generation);
    }
    const coverageChanged = startSec < oldStart || endSec > oldEnd;
    const rowsChanged = this.merge(entry, fetched.flat(), windows);
    entry.startSec = Math.min(entry.startSec, startSec);
    entry.endSec = Math.max(entry.endSec, endSec);
    entry.lastUsed = ++this.useCounter;
    if (refreshLiveEdge || endSec > oldEnd) entry.refreshedAtSec = fetchedAtSec;
    if (coverageChanged || rowsChanged) {
      entry.version += 1;
      entry.slices.clear();
    }
    return this.slice(entry, startSec, endSec);
  }

  private merge(entry: CacheEntry, incoming: Session[], windows: Array<[number, number]>): boolean {
    const byId = new Map(entry.sessions.map((session) => [session.id, session]));
    const returnedIds = new Set(incoming.map((session) => session.id));
    let changed = false;
    // Absence from a refreshed window is authoritative too: a shortened or
    // removed row must not survive merely because there is no replacement ID.
    for (const row of entry.sessions) {
      if (!returnedIds.has(row.id)
        && windows.some(([start, end]) => row.end > start && row.start < end)) {
        byId.delete(row.id);
        changed = true;
      }
    }
    for (const session of incoming) {
      const prior = byId.get(session.id);
      if (!prior || !sameSession(prior, session)) {
        byId.set(session.id, session);
        changed = true;
      }
    }
    if (changed) {
      entry.sessions = [...byId.values()].sort((a, b) => a.start - b.start || a.id - b.id);
      entry.maxEnds = maximumEnds(entry.sessions);
    }
    return changed;
  }

  private slice(entry: CacheEntry, startSec: number, endSec: number): Session[] {
    const key = `${startSec}:${endSec}`;
    const cached = entry.slices.get(key);
    if (cached?.version === entry.version) return cached.sessions;

    const out = overlappingSessions(entry.sessions, startSec, endSec, entry.maxEnds);
    entry.slices.set(key, { version: entry.version, sessions: out });
    return out;
  }

  private coveringEntry(startSec: number, endSec: number): CacheEntry | null {
    let best: CacheEntry | null = null;
    for (const entry of this.entries) {
      if (entry.startSec <= startSec && entry.endSec >= endSec) {
        if (!best || entry.sessions.length < best.sessions.length) best = entry;
      }
    }
    return best;
  }

  private bestOverlappingEntry(startSec: number, endSec: number): CacheEntry | null {
    let best: CacheEntry | null = null;
    let bestOverlap = 0;
    for (const entry of this.entries) {
      const overlap = Math.min(entry.endSec, endSec) - Math.max(entry.startSec, startSec);
      if (overlap > bestOverlap) {
        best = entry;
        bestOverlap = overlap;
      }
    }
    return best;
  }

  private needsLiveRefresh(entry: CacheEntry, endSec: number): boolean {
    const now = this.nowSec();
    // A window fetched while it was live stays unfinished until a later fetch
    // captures its final rows. Merely passing midnight cannot make it complete.
    return endSec >= Math.min(now, entry.refreshedAtSec) - LIVE_EDGE_GRACE_SEC
      && now - entry.refreshedAtSec >= this.freshForSec;
  }

  private evictOldEntries(keep: CacheEntry): void {
    while (this.entries.length > this.maxEntries) {
      let oldest = this.entries[0];
      for (const entry of this.entries) {
        if (entry !== keep && entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      const index = this.entries.indexOf(oldest);
      if (index >= 0) this.entries.splice(index, 1);
      else break;
    }
  }
}

const sharedSessionCache = new SessionWindowCache();

export function peekSessionWindow(startSec: number, endSec: number): SessionCacheHit | null {
  return sharedSessionCache.peek(startSec, endSec);
}

export function loadSessionWindow(
  startSec: number,
  endSec: number,
  fetcher: SessionFetcher,
  forceRefresh = false,
): Promise<Session[]> {
  return sharedSessionCache.load(startSec, endSec, fetcher, forceRefresh);
}

export function clearSessionWindowCache(): void {
  sharedSessionCache.clear();
}
