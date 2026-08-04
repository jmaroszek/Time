// Nothing tells the renderer that the tracker wrote a session: the two halves
// meet at the database file and never call each other. Polling on a timer would
// mean rebuilding the Activity index on every tick that found a new row — a
// linear pass over all history, ~3 s at ten years — while the reader is not even
// looking. Regaining focus is the moment the reader *is* looking, and it costs
// nothing while they are away.

/** Smallest gap between focus-driven refreshes. This only suppresses render
 *  churn from rapid alt-tabbing; the session cache still owns the decision of
 *  whether a refresh actually reaches the database. */
export const LIVE_REFRESH_MIN_INTERVAL_SEC = 1;

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface LiveRefreshTargets {
  window: Listenable;
  /** `hidden` is read at event time, so a restore from minimized is told apart
   *  from the page being hidden again. */
  document: Listenable & { readonly hidden: boolean };
}

/**
 * Calls `onRefresh` when the app comes back to the foreground. Returns an
 * unsubscribe function.
 *
 * Both events are needed and neither is redundant: `focus` covers alt-tab
 * between windows, `visibilitychange` covers minimize/restore, and on some
 * paths only one of them fires.
 */
export function subscribeLiveRefresh(
  onRefresh: () => void,
  targets: LiveRefreshTargets,
  nowSec: () => number = () => Date.now() / 1000,
  minIntervalSec: number = LIVE_REFRESH_MIN_INTERVAL_SEC,
): () => void {
  let lastSec = Number.NEGATIVE_INFINITY;
  const refresh = () => {
    const now = nowSec();
    if (now - lastSec < minIntervalSec) return;
    lastSec = now;
    onRefresh();
  };
  const onVisibility = () => {
    if (!targets.document.hidden) refresh();
  };
  targets.window.addEventListener("focus", refresh);
  targets.document.addEventListener("visibilitychange", onVisibility);
  return () => {
    targets.window.removeEventListener("focus", refresh);
    targets.document.removeEventListener("visibilitychange", onVisibility);
  };
}
