import type { ReactNode } from "react";

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-edge bg-surface p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
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
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3">
      <p className="text-xs text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-2">{sub}</p>}
    </div>
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
    default: "border-edge bg-surface-2 hover:bg-edge text-ink",
    primary: "border-accent/40 bg-accent/15 hover:bg-accent/25 text-accent",
    danger: "border-bad/30 bg-bad/10 hover:bg-bad/20 text-bad",
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
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
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
