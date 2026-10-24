import type { ReactNode, Ref } from "react";

export function Button({
  children,
  onClick,
  variant = "text",
  disabled = false,
  title,
  className = "",
  buttonRef,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "text" | "text-danger" | "text-danger-hover" | "accent" | "primary" | "danger";
  disabled?: boolean;
  title?: string;
  /** Placement only, such as the negative margin that sets a text action's
   *  word on a column's rail. The look belongs to the variant. */
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  /**
   * No variant draws an outline. A border in this app says "this holds a
   * value" — a field, a menu trigger, the selected tile in a picker — and a
   * button holds none. Buttons used to carry one anyway, so a dialog footer or
   * a panel's row of actions read as a wall of boxes louder than the content
   * they act on, and the same Cancel looked different depending on which screen
   * it was on.
   *
   * Two weights instead. Text, the Settings shape, for every action: gray at
   * rest and blue on hover so it still reads as pressable. A tint for the one
   * button in a group that commits, so it is found without an outline. Red in
   * either shape only where something is removed.
   *
   * `accent` is text in blue at rest, for a lone action that would otherwise be
   * gray text among gray labels, with nothing beside it to read as its group —
   * the same treatment as "View insights" and "Review suggestions". Use it
   * sparingly: blue everywhere would stop meaning "this one".
   *
   * The transparent border is not decoration. It keeps a button the same height
   * as a MenuSelect trigger, which has a border, wherever the two share a row.
   */
  const styles = {
    text: "text-ink-2 hover:bg-hover-2 hover:text-accent",
    "text-danger": "text-bad hover:bg-bad/10",
    "text-danger-hover": "text-ink-2 hover:bg-bad/10 hover:text-bad",
    accent: "text-accent hover:bg-accent/10",
    primary: "bg-accent/10 text-accent hover:bg-accent/[.18]",
    danger: "bg-bad/10 text-bad hover:bg-bad/[.18]",
  }[variant];
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`whitespace-nowrap rounded-lg border border-transparent px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
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
