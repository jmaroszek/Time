import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";

type WindowAction = "close" | "minimize" | "start-dragging" | "toggle-maximize";

export type TitleBarWindow = Pick<
  TauriWindow,
  | "close"
  | "isMaximized"
  | "minimize"
  | "onFocusChanged"
  | "onResized"
  | "show"
  | "startDragging"
  | "toggleMaximize"
>;

export function runWindowAction(appWindow: TitleBarWindow, action: WindowAction): Promise<void> {
  switch (action) {
    case "close":
      return appWindow.close();
    case "minimize":
      return appWindow.minimize();
    case "start-dragging":
      return appWindow.startDragging();
    case "toggle-maximize":
      return appWindow.toggleMaximize();
  }
}

export function titleBarPointerAction(
  event: Pick<PointerEvent, "button" | "detail" | "isPrimary">,
): WindowAction | null {
  if (!event.isPrimary || event.button !== 0) return null;
  return event.detail === 2 ? "toggle-maximize" : "start-dragging";
}

interface TitleBarStateHandlers {
  onFocusChange: (focused: boolean) => void;
  onMaximizedChange: (maximized: boolean) => void;
  onError?: (error: unknown) => void;
}

export interface TitleBarSubscription {
  dispose: () => void;
  ready: Promise<void>;
}

export function subscribeToTitleBarState(
  appWindow: TitleBarWindow,
  handlers: TitleBarStateHandlers,
): TitleBarSubscription {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const report = (error: unknown) => handlers.onError?.(error);

  const syncMaximized = async () => {
    try {
      const maximized = await appWindow.isMaximized();
      if (!disposed) handlers.onMaximizedChange(maximized);
    } catch (error) {
      report(error);
    }
  };

  const keep = async (listener: Promise<() => void>) => {
    try {
      const unlisten = await listener;
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    } catch (error) {
      report(error);
    }
  };

  const ready = Promise.all([
    syncMaximized(),
    keep(appWindow.onResized(() => {
      void syncMaximized();
    })),
    keep(appWindow.onFocusChanged(({ payload }) => {
      if (!disposed) handlers.onFocusChange(payload);
    })),
  ]).then(() => undefined);

  return {
    ready,
    dispose: () => {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    },
  };
}

function reportWindowError(error: unknown) {
  console.error("Window control failed", error);
}

function MinimizeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current">
      <path d="M3 11.5h10" strokeWidth="1.2" />
    </svg>
  );
}

function MaximizeIcon({ maximized }: { maximized: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current">
      {maximized ? (
        <>
          <path d="M5.5 5.5h7v7h-7z" strokeWidth="1.1" />
          <path d="M3.5 10.5v-7h7" strokeWidth="1.1" />
        </>
      ) : (
        <path d="M3.5 3.5h9v9h-9z" strokeWidth="1.1" />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current">
      <path d="m4 4 8 8m0-8-8 8" strokeWidth="1.2" />
    </svg>
  );
}

export default function WindowTitleBar({
  appWindow: suppliedWindow,
}: {
  appWindow?: TitleBarWindow;
}) {
  const [appWindow] = useState<TitleBarWindow>(() => suppliedWindow ?? getCurrentWindow());
  const [focused, setFocused] = useState(true);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // The native window starts hidden so the state plugin can restore size and
    // position without flashing the first-launch geometry. Showing from the
    // mounted titlebar keeps visibility an application policy rather than a
    // persisted window-state field.
    void appWindow.show().catch(reportWindowError);
    const subscription = subscribeToTitleBarState(appWindow, {
      onFocusChange: setFocused,
      onMaximizedChange: setMaximized,
      onError: reportWindowError,
    });
    return subscription.dispose;
  }, [appWindow]);

  const perform = (action: WindowAction) => {
    void runWindowAction(appWindow, action).catch(reportWindowError);
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const action = titleBarPointerAction(event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    perform(action);
  };

  const buttonBaseClass =
    "flex h-8 w-[46px] shrink-0 items-center justify-center text-ink-3 outline-none transition-colors duration-100";
  const buttonClass =
    `${buttonBaseClass} hover:bg-surface-2 hover:text-ink active:bg-surface-3`;

  return (
    <div className="window-titlebar">
      <div className="min-w-0 flex-1 touch-none" onPointerDown={beginDrag} />
      <div className={`flex transition-opacity duration-100 ${focused ? "" : "opacity-60"}`}>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Minimize"
          title="Minimize"
          className={buttonClass}
          onClick={() => perform("minimize")}
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          className={buttonClass}
          onClick={() => perform("toggle-maximize")}
        >
          <MaximizeIcon maximized={maximized} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close"
          title="Close"
          // A literal white is correct here, and one of the few places it is:
          // the Windows close button is red with a white glyph regardless of the
          // app's theme, so the glyph must not follow --color-bg into a light one.
          className={`${buttonBaseClass} hover:bg-window-close hover:text-white active:bg-window-close active:brightness-90`}
          onClick={() => perform("close")}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
