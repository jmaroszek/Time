import type { ReactNode, Ref } from "react";

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
  open,
  cardRef,
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
  /** Makes the whole card open something, such as a popover with more detail.
   *  A chevron after the label says so, since a card has no other look of
   *  being pressable. */
  open?: { label: string; expanded: boolean; onClick: () => void };
  cardRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={cardRef}
      className={`time-card-shadow relative rounded-xl border bg-surface px-4 py-3 transition-colors ${
        open ? (open.expanded ? "border-accent/60" : "border-card-edge hover:border-edge-2") : "border-card-edge"
      }`}
    >
      {/* Laid over the card rather than wrapped around it: the label's hint is
          its own focus stop, and a control can't hold another. The label and
          mark are positioned, so they paint above it and hovering them still
          explains the figure; the in-flow value and sub paint beneath it. */}
      {open && (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open.expanded}
          aria-label={open.label}
          onClick={open.onClick}
          className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
        />
      )}
      {/* The label paints above the overlay so its hint stays hoverable, which
          also means it eats clicks meant for the card. The chevron sits right
          beside it, so the words read as the thing to press: let the click
          through to the same handler. The cursor stays the hint's. */}
      <div className="flex items-center gap-1.5" onClick={open?.onClick}>
        {hint ? (
          <FloatingTooltip
            text={hint}
            ariaLabel={`${label}. ${hint}`}
            disabled={open?.expanded}
            className="relative cursor-help text-xs text-ink-2 outline-none"
          >
            {label}
          </FloatingTooltip>
        ) : (
          <p className="text-xs text-ink-2">{label}</p>
        )}
        {mark && <span className="relative flex">{mark}</span>}
        {open && (
          <svg
            viewBox="0 0 10 10"
            width="9"
            height="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`pointer-events-none text-ink-3 transition-transform ${open.expanded ? "rotate-180" : ""}`}
          >
            <path d="M2.5 3.75 5 6.25 7.5 3.75" />
          </svg>
        )}
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}
