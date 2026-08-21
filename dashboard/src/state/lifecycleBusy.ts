import { useSyncExternalStore } from "react";

type Listener = () => void;

let activeOperations = 0;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return activeOperations > 0;
}

/** Exported for the transport regression tests; components should subscribe
 *  through `useLifecycleBusy` so React observes changes. */
export function isLifecycleBusy(): boolean {
  return snapshot();
}

/** Shared renderer-side mirror of the native lifecycle mutex.
 *
 * The counter is intentionally transport-owned: lifecycle surfaces live both
 * inside Settings and in App-level banners, so no component can safely own
 * the gate. Native still serializes the actual work; this store only prevents
 * a second UI action or an ordinary data mutation from being offered while a
 * request is in flight.
 */
export function useLifecycleBusy(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Run one lifecycle-shaped native request while publishing its busy state.
 *
 * `finally` is the single release point, so overlapping requests keep the
 * shared state busy until the last one settles even when one rejects first.
 */
export function withLifecycleBusy<T>(operation: () => Promise<T>): Promise<T> {
  activeOperations += 1;
  notify();
  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (error) {
    activeOperations = Math.max(0, activeOperations - 1);
    notify();
    return Promise.reject(error);
  }
  return pending.finally(() => {
    activeOperations = Math.max(0, activeOperations - 1);
    notify();
  });
}
