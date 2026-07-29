import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import WindowTitleBar, {
  runWindowAction,
  subscribeToTitleBarState,
  titleBarPointerAction,
  type TitleBarWindow,
} from "./WindowTitleBar";

function createWindow(overrides: Partial<TitleBarWindow> = {}) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(true),
    minimize: vi.fn().mockResolvedValue(undefined),
    onFocusChanged: vi.fn().mockResolvedValue(() => undefined),
    onResized: vi.fn().mockResolvedValue(() => undefined),
    show: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TitleBarWindow;
}

describe("window title bar actions", () => {
  it.each([
    ["close", "close"],
    ["minimize", "minimize"],
    ["start-dragging", "startDragging"],
    ["toggle-maximize", "toggleMaximize"],
  ] as const)("maps %s to the Tauri window API", async (action, method) => {
    const appWindow = createWindow();

    await runWindowAction(appWindow, action);

    expect(appWindow[method]).toHaveBeenCalledOnce();
  });

  it("starts a native caption drag for a primary left press", () => {
    expect(titleBarPointerAction({ button: 0, detail: 1, isPrimary: true }))
      .toBe("start-dragging");
  });

  it("toggles maximize on a primary left double press", () => {
    expect(titleBarPointerAction({ button: 0, detail: 2, isPrimary: true }))
      .toBe("toggle-maximize");
  });

  it("ignores secondary and non-primary presses", () => {
    expect(titleBarPointerAction({ button: 2, detail: 1, isPrimary: true })).toBeNull();
    expect(titleBarPointerAction({ button: 0, detail: 1, isPrimary: false })).toBeNull();
  });
});

describe("window title bar state", () => {
  it("tracks maximized and focus changes and removes both listeners", async () => {
    let resized: (() => void) | undefined;
    let focusChanged: ((event: { payload: boolean }) => void) | undefined;
    const removeResize = vi.fn();
    const removeFocus = vi.fn();
    const isMaximized = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const appWindow = createWindow({
      isMaximized,
      onResized: vi.fn(async (handler) => {
        resized = handler;
        return removeResize;
      }),
      onFocusChanged: vi.fn(async (handler) => {
        focusChanged = handler;
        return removeFocus;
      }),
    });
    const onFocusChange = vi.fn();
    const onMaximizedChange = vi.fn();

    const subscription = subscribeToTitleBarState(appWindow, {
      onFocusChange,
      onMaximizedChange,
    });
    await subscription.ready;

    expect(onMaximizedChange).toHaveBeenLastCalledWith(true);
    focusChanged?.({ payload: false });
    expect(onFocusChange).toHaveBeenCalledWith(false);

    resized?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(onMaximizedChange).toHaveBeenLastCalledWith(false);

    subscription.dispose();
    expect(removeResize).toHaveBeenCalledOnce();
    expect(removeFocus).toHaveBeenCalledOnce();
  });

  it("cleans up listeners that resolve after disposal", async () => {
    let resolveResize: ((unlisten: () => void) => void) | undefined;
    const removeResize = vi.fn();
    const appWindow = createWindow({
      onResized: vi.fn(() => new Promise<() => void>((resolve) => {
        resolveResize = resolve;
      })),
    });

    const subscription = subscribeToTitleBarState(appWindow, {
      onFocusChange: vi.fn(),
      onMaximizedChange: vi.fn(),
    });
    subscription.dispose();
    resolveResize?.(removeResize);
    await subscription.ready;

    expect(removeResize).toHaveBeenCalledOnce();
  });
});

describe("window title bar markup", () => {
  it("renders only native-like controls outside the tab order", () => {
    const markup = renderToStaticMarkup(
      <WindowTitleBar appWindow={createWindow()} />,
    );

    expect(markup.match(/<button/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Minimize"');
    expect(markup).toContain('aria-label="Maximize"');
    expect(markup).toContain('aria-label="Close"');
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(markup).not.toContain("Time");
    expect(markup).not.toContain("<img");
  });
});
