import { useEffect, useRef, type ReactNode } from "react";

/**
 * The app's checkbox. Native controls are drawn by the OS — a blue square with
 * system corners in the middle of a dark rounded app — so the real input is
 * kept for behaviour and hidden, and a peer-styled span is what gets seen.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  children,
  label,
  size = "sm",
  align = "center",
  className = "",
}: {
  checked: boolean;
  /** Some but not all of what this box stands for is selected. Drawn as a dash
   *  and announced as "mixed"; clicking it selects the rest, as everywhere. */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Visible text beside the box, styled by the caller through className. */
  children?: ReactNode;
  /** The accessible name. Required where there is no visible text — a selection
   *  cell, say — and it also overrides visible text that does not say what
   *  ticking the box will do, as long as it still contains that text. */
  label?: string;
  /** "md" is for standalone hit targets like a row selector, where a 12px box
   *  is a small thing to ask someone to hit repeatedly. */
  size?: "sm" | "md";
  /** "start" keeps the box on the first line of a wrapping label. */
  align?: "center" | "start";
  className?: string;
}) {
  const box = size === "md" ? "h-4 w-4" : "h-3 w-3";
  const tick = size === "md" ? "h-3 w-3" : "h-2.5 w-2.5";
  // The DOM property, not an attribute: indeterminate cannot be set in markup,
  // and without it the control is announced as plainly unchecked.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label
      className={`group flex cursor-pointer gap-2 ${align === "start" ? "items-start" : "items-center"} ${className}`}
    >
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-[3px] border border-edge bg-surface text-ink-3 transition-colors group-hover:border-edge-2 peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-edge-2 ${box} ${align === "start" ? "mt-px" : ""}`}
      >
        {checked ? (
          <svg viewBox="0 0 12 12" className={tick} fill="none">
            <path d="m2.5 6 2.1 2.1 4.9-4.9" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        ) : indeterminate ? (
          <svg viewBox="0 0 12 12" className={tick} fill="none">
            <path d="M3 6h6" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        ) : null}
      </span>
      {children}
    </label>
  );
}
