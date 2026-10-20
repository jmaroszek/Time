import type { ReactNode } from "react";

import { FloatingTooltip } from "./FloatingTooltip";

export function Card({
  title,
  right,
  children,
  className = "",
  surface = "default",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Large analytical canvases use a barely tinted light surface to reduce
   *  glare. Dark aliases it to the existing card, so that theme does not move. */
  surface?: "default" | "chart";
}) {
  return (
    <div className={`time-card-shadow min-w-0 rounded-[14px] border border-card-edge ${surface === "chart" ? "bg-chart-surface" : "bg-surface"} p-4 sm:p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 text-sm font-semibold text-ink">{title}</h2>
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
  mark,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional explanation shown when the card title is hovered or focused. */
  hint?: string;
  /** A small glyph beside the label, for a state the figure itself shouldn't
   *  carry. It sits with the label rather than the value on purpose: the figure
   *  is the measurement, and anything appended there competes with reading it. */
  mark?: ReactNode;
}) {
  return (
    <div className="time-card-shadow rounded-xl border border-card-edge bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5">
        {hint ? (
          <FloatingTooltip
            text={hint}
            ariaLabel={`${label}. ${hint}`}
            className="cursor-help text-xs text-ink-2 outline-none"
          >
            {label}
          </FloatingTooltip>
        ) : (
          <p className="text-xs text-ink-2">{label}</p>
        )}
        {mark}
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}
