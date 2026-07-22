import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  /** Optional explanation shown when the card title is hovered or focused. */
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3">
      <p
        tabIndex={hint ? 0 : undefined}
        aria-label={hint ? `${label}. ${hint}` : undefined}
        className={`group relative w-fit text-xs text-ink-2 outline-none ${hint ? "cursor-help" : ""}`}
      >
        {label}
        {hint && <InfoHint text={hint} />}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}

/** Positioned tooltip shared by the card's hover and title focus states. */
function InfoHint({ text }: { text: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible absolute left-0 top-5 z-20 w-56 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-[11px] font-normal leading-snug text-ink-2 opacity-0 shadow-lg transition-opacity delay-0 duration-100 group-hover:visible group-hover:opacity-100 group-hover:delay-500 group-focus:visible group-focus:opacity-100 group-focus:delay-0"
    >
      {text}
    </span>
  );
}

/** A delayed tooltip rendered outside scroll containers so it cannot create
 * overflow or be clipped by the content it describes. */
export function FloatingTooltip({
  text,
  children,
  className = "",
}: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const hide = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPosition(null);
  };
  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 208;
    const estimatedHeight = 48;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + estimatedHeight <= window.innerHeight
      ? below
      : Math.max(8, rect.top - estimatedHeight - 6);
    setPosition({ left, top });
  };
  const scheduleShow = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(show, 500);
  };

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <span
      ref={triggerRef}
      tabIndex={0}
      aria-label={text}
      className={className}
      onMouseEnter={scheduleShow}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {children}
      {position && createPortal(
        <span
          role="tooltip"
          style={{ left: position.left, top: position.top }}
          className="pointer-events-none fixed z-50 w-52 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-left text-[11px] font-normal leading-snug text-ink-2 shadow-lg"
        >
          {text}
        </span>,
        document.body,
      )}
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

export function TextInput({
  value,
  onChange,
  onCommit,
  type = "text",
  className = "",
  placeholder,
  min,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
  type?: string;
  className?: string;
  placeholder?: string;
  min?: string;
  max?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      min={min}
      max={max}
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
  blurOnChange = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  blurOnChange?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        if (blurOnChange) e.currentTarget.blur();
      }}
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
