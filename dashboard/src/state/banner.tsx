// One shared, dismissible error banner for failed writes. Tabs call
// report(error, subject) from any .catch; the provider renders a single quiet
// banner rather than a per-call toast system.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { explainDbError } from "../lib/dbErrors";

interface Banner {
  /** Show a friendly message for a caught write failure. */
  report: (error: unknown, subject?: string) => void;
  /** Show an already-human message (e.g. validation feedback). */
  show: (message: string) => void;
}

const BannerContext = createContext<Banner | null>(null);

export function BannerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);

  const show = useCallback((msg: string) => setMessage(msg), []);
  const report = useCallback(
    (error: unknown, subject?: string) => setMessage(explainDbError(error, subject)),
    [],
  );
  const value = useMemo<Banner>(() => ({ report, show }), [report, show]);

  return (
    <BannerContext.Provider value={value}>
      {children}
      {message && (
        <div className="fixed inset-x-0 bottom-5 z-[60] flex justify-center px-6">
          <div
            role="alert"
            className="flex max-w-xl items-center gap-3 rounded-[11px] border border-bad/40 bg-surface-2 px-4 py-2.5 text-xs text-ink shadow-[0_12px_34px_rgba(0,0,0,.5)]"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-bad" />
            <span className="min-w-0">{message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="ml-1 shrink-0 rounded-md px-1.5 py-1 text-ink-3 transition-colors hover:bg-white/[.05] hover:text-ink"
              onClick={() => setMessage(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </BannerContext.Provider>
  );
}

export function useBanner(): Banner {
  const ctx = useContext(BannerContext);
  if (!ctx) throw new Error("useBanner outside BannerProvider");
  return ctx;
}
