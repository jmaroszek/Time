import type { Session } from "./metrics";

/** Mirrors the overlap bound used by the native session query. */
export const MAX_SESSION_SPAN_SEC = 7 * 86_400;

const LIVE_EDGE_GRACE_SEC = 120;
const DEFAULT_FRESH_FOR_SEC = 5;
const DEFAULT_MAX_ENTRIES = 2;
const LIVE_REFRESH_OVERLAP_SEC = 60;

export type SessionFetcher = (startSec: number, endSec: number) => Promise<Session[]>;

export interface SessionCacheHit {
  sessions: Session[];
  stale: boolean;
}

interface CacheEntry {
  startSec: number;
  endSec: number;
  sessions: Session[];
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
    left.isAfk === right.isAfk
  );
}

function lowerBoundByStart(sessions: Session[], value: number): number {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sessions[middle].start <= value) low = middle + 1;
    else high = middle;
  }
  return low;
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

  constructor(
    private readonly nowSec: () => number = () => Date.now() / 1000,
    private readonly freshForSec = DEFAULT_FRESH_FOR_SEC,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  clear(): void {
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

    const promise = this.loadUnshared(startSec, endSec, fetcher, forceRefresh).finally(() => {
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
  ): Promise<Session[]> {
    if (forceRefresh) {
      const sessions = await fetcher(startSec, endSec);
      for (let index = this.entries.length - 1; index >= 0; index--) {
        const existing = this.entries[index];
        if (Math.min(existing.endSec, endSec) > Math.max(existing.startSec, startSec)) {
          this.entries.splice(index, 1);
        }
      }
      const replacement: CacheEntry = {
        startSec,
        endSec,
        sessions: [...sessions].sort((a, b) => a.start - b.start || a.id - b.id),
        refreshedAtSec: this.nowSec(),
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
      const sessions = await fetcher(startSec, endSec);
      entry = {
        startSec,
        endSec,
        sessions: [...sessions].sort((a, b) => a.start - b.start || a.id - b.id),
        refreshedAtSec: this.nowSec(),
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
    const segments: Array<[number, number]> = [];
    if (startSec < oldStart) segments.push([startSec, Math.min(oldStart, endSec)]);
    if (endSec > oldEnd) segments.push([Math.max(oldEnd, startSec), endSec]);

    const refreshLiveEdge = endSec <= oldEnd && this.needsLiveRefresh(entry, endSec);
    if (refreshLiveEdge) {
      const refreshEnd = Math.min(endSec, oldEnd);
      const refreshStart = Math.max(startSec, this.nowSec() - LIVE_REFRESH_OVERLAP_SEC);
      if (refreshEnd > refreshStart) segments.push([refreshStart, refreshEnd]);
    }

    const fetched = await Promise.all(segments.map(([from, to]) => fetcher(from, to)));
    const coverageChanged = startSec < oldStart || endSec > oldEnd;
    const rowsChanged = this.merge(entry, fetched.flat());
    entry.startSec = Math.min(entry.startSec, startSec);
    entry.endSec = Math.max(entry.endSec, endSec);
    entry.lastUsed = ++this.useCounter;
    if (endSec >= this.nowSec() - LIVE_EDGE_GRACE_SEC) entry.refreshedAtSec = this.nowSec();
    if (coverageChanged || rowsChanged) {
      entry.version += 1;
      entry.slices.clear();
    }
    return this.slice(entry, startSec, endSec);
  }

  private merge(entry: CacheEntry, incoming: Session[]): boolean {
    if (incoming.length === 0) return false;
    const byId = new Map(entry.sessions.map((session) => [session.id, session]));
    let changed = false;
    for (const session of incoming) {
      const prior = byId.get(session.id);
      if (!prior || !sameSession(prior, session)) {
        byId.set(session.id, session);
        changed = true;
      }
    }
    if (changed) {
      entry.sessions = [...byId.values()].sort((a, b) => a.start - b.start || a.id - b.id);
    }
    return changed;
  }

  private slice(entry: CacheEntry, startSec: number, endSec: number): Session[] {
    const key = `${startSec}:${endSec}`;
    const cached = entry.slices.get(key);
    if (cached?.version === entry.version) return cached.sessions;

    const out: Session[] = [];
    const first = lowerBoundByStart(entry.sessions, startSec - MAX_SESSION_SPAN_SEC);
    for (let index = first; index < entry.sessions.length; index++) {
      const session = entry.sessions[index];
      if (session.start >= endSec) break;
      if (session.end > startSec) out.push(session);
    }
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
    return endSec >= now - LIVE_EDGE_GRACE_SEC && now - entry.refreshedAtSec >= this.freshForSec;
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
