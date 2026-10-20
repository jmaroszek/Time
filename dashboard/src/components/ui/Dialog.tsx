import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import { TextInput } from "./TextInput";

export interface ConfirmMetric {
  label: string;
  value: string;
}

/**
 * Shared modal mechanics. Dialog contents choose their own width and anatomy;
 * this shell owns the behavior every modal must have: a body-level portal,
 * initial focus, a complete focus trap, Escape, and scrim dismissal.
 */
export function DialogShell({
  children,
  onClose,
  busy = false,
  labelledBy,
  describedBy,
  label,
  className = "max-w-md",
}: {
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  labelledBy?: string;
  describedBy?: string;
  label?: string;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim p-2 sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )];
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className={`scroll-well max-h-[calc(100dvh-1rem)] w-full overflow-y-auto rounded-[14px] border border-edge-2 bg-surface p-4 shadow-panel outline-none sm:max-h-[calc(100dvh-2rem)] sm:p-5 ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The app's confirmation for a destructive action, with the same anatomy as
 * DeleteActivityDialog: what is about to happen, how much of it there is, and
 * one button that commits.
 *
 * It exists because four of these were `window.confirm` and `window.prompt` —
 * including erasing all recorded history, the highest-stakes action in the
 * product, which had the cheapest dialog in it. A native confirm cannot show a
 * count, cannot be read at the same size as the page, and puts the destructive
 * choice wherever the OS decides.
 *
 * `requireTyped` replaces the prompt that asked for the word DELETE: the same
 * gate, but with the consequence visible above the field rather than in a
 * sentence the reader has to parse before typing.
 */
export function ConfirmDialog({
  title,
  body,
  metrics,
  note,
  confirmLabel,
  busyLabel,
  busy = false,
  confirmDisabled = false,
  variant = "danger",
  requireTyped,
  extraAction,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  /** Tiles quantifying the blast radius. Omitted when there is nothing to count. */
  metrics?: ConfirmMetric[];
  /** What cannot be undone, and what survives. */
  note?: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  /** Prevent committing while prerequisite data or a valid selection is absent. */
  confirmDisabled?: boolean;
  /** "danger" commits a deletion; "default" for a reset that destroys no data. */
  variant?: "danger" | "default";
  /** Word the reader must type before the commit button enables. */
  requireTyped?: string;
  /** A non-committing escape hatch — "Back up first", say. */
  extraAction?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const satisfied = requireTyped === undefined || typed.trim() === requireTyped;

  return (
    <DialogShell onClose={onClose} busy={busy} labelledBy={`${id}-title`}>
        <h2 id={`${id}-title`} className="text-sm font-semibold">{title}</h2>
        <div className="mt-3 text-xs leading-snug text-ink-2">{body}</div>
        {metrics && metrics.length > 0 && (
          <div className={`mt-3 grid gap-2 ${metrics.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {metrics.map((metric) => (
              <div key={metric.label} className="rounded-lg border border-edge bg-surface-2 p-3">
                <p className="text-xs text-ink-3-raised">{metric.label}</p>
                <p className="mt-1 text-sm font-semibold tabular-nums">{metric.value}</p>
              </div>
            ))}
          </div>
        )}
        {note && <p className="mt-3 text-xs leading-snug text-ink-3">{note}</p>}
        {requireTyped !== undefined && (
          <label className="mt-3 block">
            <span className="text-xs text-ink-2">
              Type <span className="font-mono font-semibold text-ink">{requireTyped}</span> to confirm
            </span>
            <TextInput
              value={typed}
              onChange={setTyped}
              onCommit={() => satisfied && !busy && onConfirm()}
              className="mt-1.5 w-full font-mono"
            />
          </label>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          {extraAction}
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            disabled={busy || confirmDisabled || !satisfied}
            onClick={onConfirm}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </div>
    </DialogShell>
  );
}
