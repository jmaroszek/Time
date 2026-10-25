import type { ReactNode } from "react";

/**
 * The app's radio button, built as Checkbox is and for the same reason: the
 * native control is drawn by the OS. The real input stays for behaviour —
 * arrow keys move within its `name` group — and a peer-styled span is seen.
 */
export function Radio({
  name,
  checked,
  onChange,
  children,
  className = "",
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  /** The visible label, styled by the caller. */
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`group flex items-center gap-2.5 ${className}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border bg-surface transition-colors peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-edge-2 ${
          checked ? "border-accent/70" : "border-edge group-hover:border-edge-2"
        }`}
      >
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      {children}
    </label>
  );
}
