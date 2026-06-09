// Fetch sessions overlapping a unix-seconds window, with loading/error state.

import { useEffect, useState } from "react";

import type { Session } from "../lib/metrics";
import { fetchSessions } from "../lib/queries";

export interface SessionData {
  sessions: Session[];
  loading: boolean;
  error: string | null;
}

export function useSessions(startSec: number, endSec: number, bump = 0): SessionData {
  const [state, setState] = useState<SessionData>({ sessions: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetchSessions(startSec, endSec)
      .then((sessions) => {
        if (!cancelled) setState({ sessions, loading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ sessions: [], loading: false, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [startSec, endSec, bump]);

  return state;
}
