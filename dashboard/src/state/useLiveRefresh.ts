// Counter that advances each time the app returns to the foreground. Threaded
// into useSessions the same way historyRevision is, but deliberately *not* as a
// history bump: a bump forces a full refetch and drops the caches, which is the
// expensive path. This one only re-runs the fetch effect, leaving the session
// cache to refresh its live edge and merge — so a return that found nothing new
// keeps every cached array identity and costs no re-analysis at all.

import { useEffect, useState } from "react";

import { subscribeLiveRefresh } from "../lib/liveRefresh";

export function useLiveRefresh(): number {
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      subscribeLiveRefresh(() => setTick((current) => current + 1), {
        window,
        document,
      }),
    [],
  );
  return tick;
}
