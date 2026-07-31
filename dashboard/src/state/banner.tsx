// One shared banner for the results of writes. Tabs call report(error, subject)
// from any .catch and show(message) on success; the provider renders a single
// quiet banner rather than a per-call toast system.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { explainDbError } from "../lib/dbErrors";

/** "good" confirms something that worked; "bad" reports a write that failed. */
export type BannerTone = "good" | "bad";

/**
 * How long a banner stays before clearing itself, or null to stay until
 * dismissed.
 *
 * A confirmation has already done its job the moment it is read — leaving it on
 * screen makes the reader clear away news of their own success. A failure is
 * the opposite: it is the only record that the write did not happen, and
 * something needs deciding about it, so it waits.
 */
export function bannerDismissMs(tone: BannerTone): number | null {
  return tone === "good" ? 4500 : null;
}

/**
 * One optional action offered beside a confirmation, for a write that is cheap
 * to make by accident — the Unclassified section's assignments, where the whole
 * point is that a category is one click away. Running it clears the banner: the
 * news it carried is no longer true.
 */
export interface BannerAction {
  label: string;
  run: () => void;
}

interface Banner {
  /** Show a friendly message for a caught write failure. */
  report: (error: unknown, subject?: string) => void;
  /** Confirm something that succeeded. */
  show: (message: string, action?: BannerAction) => void;
}

const BannerContext = createContext<Banner | null>(null);

export function BannerProvider({ children }: { children: ReactNode }) {
  const [banner, setBanner] = useState<
    { message: string; tone: BannerTone; action?: BannerAction } | null
  >(null);

  const show = useCallback(
    (message: string, action?: BannerAction) => setBanner({ message, tone: "good", action }),
    [],
  );
  const report = useCallback(
    (error: unknown, subject?: string) =>
      setBanner({ message: explainDbError(error, subject), tone: "bad" }),
    [],
  );
  const value = useMemo<Banner>(() => ({ report, show }), [report, show]);

  const tone = banner?.tone;
  const message = banner?.message;
  useEffect(() => {
    if (tone === undefined) return;
    const after = bannerDismissMs(tone);
    if (after === null) return;
    // Keyed on the message too, so a second confirmation restarts the clock
    // rather than inheriting the remainder of the first one's.
    const timer = setTimeout(() => setBanner(null), after);
    return () => clearTimeout(timer);
  }, [tone, message]);

  return (
    <BannerContext.Provider value={value}>
      {children}
      {banner && (
        <div className="fixed inset-x-0 bottom-5 z-[60] flex justify-center px-6">
          <div
            // Polite for a confirmation, assertive for a failure: one is worth
            // interrupting what a screen reader is saying, the other is not.
            role={banner.tone === "bad" ? "alert" : "status"}
            className={`flex max-w-xl items-center gap-3 rounded-[11px] border bg-surface-2 px-4 py-2.5 text-xs text-ink shadow-menu ${
              banner.tone === "bad" ? "border-bad/40" : "border-good/40"
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${banner.tone === "bad" ? "bg-bad" : "bg-good"}`}
            />
            <span className="min-w-0">{banner.message}</span>
            {banner.action && (
              <button
                type="button"
                className="shrink-0 rounded-md border border-edge-2 px-2 py-1 text-ink transition-colors hover:bg-hover-2"
                onClick={() => {
                  const run = banner.action?.run;
                  setBanner(null);
                  run?.();
                }}
              >
                {banner.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              className="ml-1 shrink-0 rounded-md px-1.5 py-1 text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink"
              onClick={() => setBanner(null)}
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
