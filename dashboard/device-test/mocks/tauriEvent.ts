// Only the update download reports progress, and only while it is running, so
// this carries no state beyond the listeners themselves. Specs that need to
// drive a download call window.__TIME_DEVICE_EVENTS__.emit().

type Listener = (event: { payload: unknown }) => void;

declare global {
  interface Window {
    __TIME_DEVICE_EVENTS__: {
      emit: (name: string, payload: unknown) => void;
    };
  }
}

const listeners = new Map<string, Set<Listener>>();

window.__TIME_DEVICE_EVENTS__ = {
  emit: (name, payload) => {
    for (const listener of listeners.get(name) ?? []) listener({ payload });
  },
};

export async function listen<T>(
  name: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  const set = listeners.get(name) ?? new Set<Listener>();
  set.add(handler as Listener);
  listeners.set(name, set);
  return () => {
    set.delete(handler as Listener);
  };
}
