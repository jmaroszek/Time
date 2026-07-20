// Fetch sessions overlapping a unix-seconds window, with loading/error state.

import { useEffect, useRef, useState } from "react";

import type { Session } from "../lib/metrics";
import { fetchSessions } from "../lib/queries";
import { loadSessionWindow, peekSessionWindow } from "../lib/sessionWindowCache";

export interface SessionData {
  sessions: Session[];
  /** True when `sessions` covers the window requested by this render. */
  ready: boolean;
  loading: boolean;
  /** Cached data is usable now while its live edge is refreshed in place. */
  refreshing: boolean;
  error: string | null;
}

interface SettledSessionData {
  sessions: Session[];
  startSec: number;
  endSec: number;
  bump: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

export function useSessions(startSec: number, endSec: number, bump = 0): SessionData {
  const [state, setState] = useState<SettledSessionData>(() => {
    const initial = peekSessionWindow(startSec, endSec);
    return {
      sessions: initial?.sessions ?? [],
      startSec,
      endSec,
      bump,
      loading: initial === null,
      refreshing: initial?.stale ?? false,
      error: null,
    };
  });
  const previousBump = useRef(bump);

  // Cache hits are intentionally read during render: a covered duration switch
  // can use its stable slice immediately, without waiting one effect/microtask.
  const cached = peekSessionWindow(startSec, endSec);
  const stateMatches =
    state.startSec === startSec && state.endSec === endSec && state.bump === bump;

  useEffect(() => {
    let cancelled = false;
    const forceRefresh = previousBump.current !== bump;
    previousBump.current = bump;
    const hit = peekSessionWindow(startSec, endSec);
    setState((current) => ({
      sessions: hit?.sessions ?? current.sessions,
      startSec,
      endSec,
      bump,
      loading: hit === null,
      refreshing: hit?.stale ?? false,
      error: null,
    }));
    loadSessionWindow(startSec, endSec, fetchSessions, forceRefresh)
      .then((sessions) => {
        if (!cancelled) {
          setState({
            sessions,
            startSec,
            endSec,
            bump,
            loading: false,
            refreshing: false,
            error: null,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            startSec,
            endSec,
            bump,
            loading: false,
            refreshing: false,
            error: String(e),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [startSec, endSec, bump]);

  if (cached) {
    return {
      sessions: cached.sessions,
      ready: true,
      loading: false,
      refreshing: cached.stale || (stateMatches && state.refreshing),
      error: stateMatches ? state.error : null,
    };
  }
  return {
    sessions: state.sessions,
    ready: stateMatches && !state.loading && state.error === null,
    loading: !stateMatches || state.loading,
    refreshing: stateMatches && state.refreshing,
    error: stateMatches ? state.error : null,
  };
}
