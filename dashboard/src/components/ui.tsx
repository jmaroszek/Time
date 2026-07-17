import type { ReactNode } from "react";

export function Card({
  title,
  right,
  children,
  className = "",
  titleAlign = "left",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  titleAlign?: "left" | "center";
}) {
  return (
    <div className={`rounded-[14px] border border-edge bg-surface p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          <h2
            className={`text-sm font-semibold text-ink ${titleAlign === "center" ? "w-full text-center" : ""}`}
          >
            {title}
          </h2>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional explanation shown as a hover tooltip on a small ⓘ next to the label. */
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3">
      <p className="flex items-center gap-1 text-xs text-ink-2">
        {label}
        {hint && <InfoHint text={hint} />}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}

/** A ⓘ that reveals an explanation on hover or keyboard focus. Uses a real
 *  positioned element (not the native `title`, which never shows on click and
 *  is unreliable on hover). */
function InfoHint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        aria-label={text}
        className="cursor-help select-none text-ink-3 outline-none hover:text-ink-2"
      >
        ⓘ
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-5 z-20 hidden w-56 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-[11px] font-normal leading-snug text-ink-2 shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled = false,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "danger" | "primary";
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    default: "border-edge-2 bg-transparent hover:bg-white/[.035] text-ink-2 hover:text-ink",
    primary: "border-accent/30 bg-transparent hover:bg-accent/15 text-accent",
    danger: "border-bad/30 bg-transparent hover:bg-bad/15 text-bad",
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

export function TextInput({
  value,
  onChange,
  onCommit,
  type = "text",
  className = "",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  type?: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => e.key === "Enter" && onCommit?.()}
      className={`rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent/60 ${className}`}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-lg border border-edge bg-surface-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CategoryDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-ink-2">{label}</div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-ink-3">{message}</div>
  );
}
