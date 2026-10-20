import type { ReactNode } from "react";

export function Button({
  children,
  onClick,
  variant = "default",
  disabled = false,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "danger" | "quiet-danger" | "primary" | "primary-fill" | "text" | "text-danger";
  disabled?: boolean;
  title?: string;
}) {
  /**
   * One resting shape for every variant — `border-edge` over a fill — with hue
   * carried by the fill and the text alone.
   *
   * Two things were wrong before. The border was `edge-2`, the brightest edge
   * the app has and the only place it appeared at rest; MenuSelect reserves
   * that same value for *hover*, so a button sat permanently as bright as a
   * dropdown under the pointer. And with no fill, that border carried the
   * entire signal.
   *
   * Adopting MenuSelect's `border-edge + bg-surface-2` makes buttons and
   * dropdowns one family. Keeping the border neutral on the tinted variants
   * matters as much: a red border *and* a red fill made the danger button
   * differ from its neighbours on two axes at once, which is what made it
   * shout. Now only the hue changes, and `edge-2` means hover again.
   */
  const styles = {
    default: "border-edge bg-surface-2 text-ink-2 hover:border-edge-2 hover:text-ink",
    primary: "border-edge bg-accent/10 text-accent hover:border-accent/40 hover:bg-accent/[.18]",
    // The primary's fill without its outline, to sit beside `text` actions:
    // the tint alone marks it as the one that commits.
    "primary-fill": "border-transparent bg-accent/10 text-accent hover:bg-accent/[.18]",
    danger: "border-edge bg-bad/10 text-bad hover:border-bad/40 hover:bg-bad/[.18]",
    // For a button that *opens* a destructive flow rather than performing one.
    // It rests exactly as an ordinary control does and takes the warning colour
    // only once the pointer is on it — the dialog it raises does the shouting.
    // Reserve the plain `danger` for the button that actually commits.
    "quiet-danger": "border-edge bg-surface-2 text-ink-2 hover:border-bad/40 hover:bg-bad/10 hover:text-bad",
    // Borderless, as Settings' text actions are: gray at rest, blue on hover,
    // red only for the one that removes history.
    text: "border-transparent font-semibold text-ink-2 hover:bg-hover-2 hover:text-accent",
    "text-danger": "border-transparent font-semibold text-bad hover:bg-bad/10",
  }[variant];
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function TrashButton({
  label,
  disabled = false,
  compact = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center rounded-[9px] border border-bad/30 text-bad transition-colors hover:border-bad/50 hover:bg-bad/5 disabled:cursor-not-allowed disabled:opacity-35 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
    >
      <svg width={compact ? 13 : 15} height={compact ? 13 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

/** Row-level delete. A trash can carries the weight of a destructive command;
 *  removing one line from a list it sits in does not, so the quiet ✕ only picks
 *  up the danger tint on hover. Deletes with real blast radius keep words. */
export function RemoveButton({
  label,
  compact = false,
  onClick,
}: {
  label: string;
  /** For a ✕ that sits inline with small text rather than at the end of a row
   *  of its own. At the default size it outweighs a 12px line beside it. */
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex shrink-0 items-center justify-center rounded-md leading-none text-ink-3 transition-colors hover:bg-bad/10 hover:text-bad ${
        compact ? "h-5 w-5 text-xs" : "h-6 w-6 text-sm"
      }`}
    >
      ✕
    </button>
  );
}
