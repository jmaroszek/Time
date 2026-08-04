import { describe, expect, it, vi } from "vitest";

import { subscribeLiveRefresh } from "./liveRefresh";

function targets(hidden = false) {
  const handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const listenable = {
    addEventListener: vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
      handlers.get(type)?.delete(handler);
    }),
  };
  const state = { hidden };
  return {
    handlers,
    state,
    fire(type: string) {
      for (const handler of handlers.get(type) ?? []) (handler as EventListener)(new Event(type));
    },
    value: {
      window: listenable,
      document: {
        ...listenable,
        get hidden() {
          return state.hidden;
        },
      },
    },
  };
}

describe("subscribeLiveRefresh", () => {
  it("refreshes on focus and on becoming visible again", () => {
    const host = targets();
    const onRefresh = vi.fn();
    let now = 0;
    subscribeLiveRefresh(onRefresh, host.value, () => now);

    host.fire("focus");
    now = 10;
    host.fire("visibilitychange");

    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("ignores a visibility change that hid the app", () => {
    const host = targets();
    const onRefresh = vi.fn();
    subscribeLiveRefresh(onRefresh, host.value, () => 0);

    host.state.hidden = true;
    host.fire("visibilitychange");

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("throttles a burst of focus events into one refresh", () => {
    const host = targets();
    const onRefresh = vi.fn();
    let now = 100;
    subscribeLiveRefresh(onRefresh, host.value, () => now, 5);

    host.fire("focus");
    now = 102;
    host.fire("focus");
    now = 104;
    host.fire("focus");
    expect(onRefresh).toHaveBeenCalledTimes(1);

    now = 106;
    host.fire("focus");
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("stops listening once unsubscribed", () => {
    const host = targets();
    const onRefresh = vi.fn();
    let now = 0;
    const unsubscribe = subscribeLiveRefresh(onRefresh, host.value, () => now);

    unsubscribe();
    now = 100;
    host.fire("focus");
    host.fire("visibilitychange");

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
