import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { moveIndex, typeaheadIndex } from "../lib/menuNav";

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

/** Row-level delete. A trash can carries the weight of a destructive command;
 *  removing one line from a list it sits in does not, so the quiet ✕ only picks
 *  up the danger tint on hover. Deletes with real blast radius keep words. */
export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm leading-none text-ink-3 transition-colors hover:bg-bad/10 hover:text-bad"
    >
      ✕
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

export interface MenuOption {
  value: string;
  label: string;
  /** Draws a rule above this entry. Opt-in: only for lists where the break
   *  says something, not as decoration every few rows. */
  divider?: boolean;
  /** Swatch shown before the label, and on the trigger once chosen. */
  dot?: string;
}

const MENU_VIEWPORT_MARGIN = 8;

const SIZES = {
  control: "rounded-lg px-2.5 py-1.5 text-xs",
  field: "rounded-[9px] px-2.5 py-2 text-xs",
  compact: "rounded-md px-2 py-1 text-[10.5px]",
} as const;

const VARIANTS = {
  default: "border-edge bg-surface-2 text-ink hover:border-edge-2 focus-visible:border-accent/60",
  quiet: "menu-quiet",
  bare: "border-transparent text-ink-3 hover:bg-surface-3 disabled:hover:bg-transparent",
} as const;
/** Windows list views forget a typeahead buffer after roughly a second. */
const TYPEAHEAD_RESET_MS = 900;

/**
 * A select rendered as our own listbox rather than a native <select>.
 *
 * The reason is that the open list of a native select is drawn by the OS,
 * outside the document, so no stylesheet reaches it — a WebView2 popup with
 * square corners and a system highlight in the middle of a rounded dark app.
 *
 * The cost is that everything the native control gave away for free — arrow
 * keys, typeahead, Home/End, focus return — is ours to implement. Movement
 * lives in lib/menuNav.ts and is tested there.
 *
 * The popup is portalled to <body> because these sit inside cards that clip
 * their overflow; positioning it in flow would require every such card to
 * open its overflow while a menu is up.
 */
export function MenuSelect({
  value,
  onChange,
  options,
  className = "",
  label,
  variant = "default",
  size = "control",
  align = "start",
  placeholder,
  header,
  disabled = false,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: MenuOption[];
  className?: string;
  /** Accessible name; the trigger shows only the current selection. */
  label?: string;
  /** "quiet" dims the resting trigger so a selector sitting on a chart card
   *  does not compete with the chart it annotates. "bare" drops the border
   *  for triggers that read as a row value rather than a form control. */
  variant?: "default" | "quiet" | "bare";
  /** "field" matches the taller text inputs, for menus that sit in a row
   *  beside one. Passing the padding through className instead would leave
   *  which utility wins up to Tailwind's ordering rather than the call site. */
  size?: "control" | "field" | "compact";
  /** Which trigger edge the menu lines up with. Right-anchored controls want
   *  "end" so a menu wider than its trigger grows inward. */
  align?: "start" | "end";
  /** Shown on the trigger when `value` matches no option. An action menu —
   *  one that fires a command and keeps no selection — passes "" as its value
   *  and a prompt here. Also carries a value the list no longer offers. */
  placeholder?: ReactNode;
  /** Explanatory line above the options. Sits outside the listbox, since it
   *  is not selectable and screen readers should not count it as a row. */
  header?: string;
  disabled?: boolean;
  title?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ left: number; top: number; minWidth: number } | null>(null);

  // -1 when the value names nothing in the list, which is how an action menu
  // (placeholder trigger, no standing choice) renders: no row gets a check.
  const selected = options.findIndex((o) => o.value === value);
  const current = options[selected];

  const close = (refocus = true) => {
    setOpen(false);
    setActive(-1);
    typeahead.current = { buffer: "", at: 0 };
    if (refocus) triggerRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close();
  };

  // Measured after paint so the real menu height decides whether it opens
  // downward; an estimate here would flip a menu that actually fits.
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      // The menu sizes itself to its longest label (width: max-content in the
      // style below), so its width is read back rather than computed — a fixed
      // floor would leave a short list like "Top 5" stranded in dead space.
      const menu = listRef.current?.getBoundingClientRect();
      const width = menu?.width ?? trigger.width;
      const height = menu?.height ?? 0;
      const below = trigger.bottom + 5;
      const fitsBelow = below + height <= window.innerHeight - MENU_VIEWPORT_MARGIN;
      const anchored = align === "end" ? trigger.right - width : trigger.left;
      setBox({
        left: Math.max(
          MENU_VIEWPORT_MARGIN,
          Math.min(anchored, window.innerWidth - width - MENU_VIEWPORT_MARGIN),
        ),
        top: fitsBelow ? below : Math.max(MENU_VIEWPORT_MARGIN, trigger.top - height - 5),
        // Never narrower than the control it belongs to; a menu that undercuts
        // its own trigger reads as a detached tooltip.
        minWidth: trigger.width,
      });
    };
    place();
    // The page scrolls under a fixed-position popup, so follow the trigger
    // rather than leaving the menu stranded mid-page.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setActive(selected);
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      // Tab closes and then moves on; trapping focus in a menu this small
      // would cost more than it protects.
      close(event.key === "Escape");
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(active < 0 ? selected : active);
      return;
    }
    const moved = moveIndex(event.key, active, options.length);
    if (moved !== null) {
      event.preventDefault();
      setActive(moved);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const now = performance.now();
      const { buffer, at } = typeahead.current;
      const next = now - at > TYPEAHEAD_RESET_MS ? event.key : buffer + event.key;
      typeahead.current = { buffer: next, at: now };
      const hit = typeaheadIndex(options.map((o) => o.label), next, active);
      if (hit !== null) {
        event.preventDefault();
        setActive(hit);
      }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        title={title}
        onClick={() => (open ? close() : (setActive(selected), setOpen(true)))}
        onKeyDown={onKeyDown}
        className={`flex items-center justify-between gap-2 border outline-none transition-colors disabled:cursor-not-allowed ${SIZES[size]} ${
          open ? "border-accent/60 bg-surface-3 text-ink" : VARIANTS[variant]
        } ${className}`}
      >
        <span className={`flex min-w-0 items-center gap-1.5 ${current ? "" : "text-ink-3"}`}>
          {current ? (
            <>
              {current.dot && <CategoryDot color={current.dot} />}
              <span className="truncate">{current.label}</span>
            </>
          ) : placeholder}
        </span>
        {/* A bare trigger reads as a row value rather than a control, so it
            drops the chevron too — and the width it frees is what lets a word
            like "unproductive" fit without truncating. */}
        {variant !== "bare" && (
          <svg
            viewBox="0 0 12 12"
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
              open ? "rotate-180 text-accent" : "text-ink-3"
            }`}
            fill="none"
          >
            <path d="m2.5 4.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open && createPortal(
        <div
          ref={listRef}
          style={{
            left: box?.left ?? 0,
            top: box?.top ?? 0,
            width: "max-content",
            minWidth: box?.minWidth,
            maxWidth: `calc(100vw - ${MENU_VIEWPORT_MARGIN * 2}px)`,
            // Hidden for the frame between mount and measurement, so the menu
            // never flashes at the top-left corner.
            visibility: box ? "visible" : "hidden",
          }}
          className="menu-pop fixed z-50 rounded-[11px] border border-edge-2 bg-surface-2 p-1 shadow-[0_12px_34px_rgba(0,0,0,.5)]"
        >
          {header && (
            <p className="px-2.5 py-1.5 text-[10px] leading-snug text-ink-3">{header}</p>
          )}
          <div id={`${id}-list`} role="listbox" aria-label={label}>
          {options.map((option, i) => (
            <div key={option.value}>
              {option.divider && <div className="mx-1.5 my-1 h-px bg-edge" />}
              <button
                type="button"
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === selected}
                onClick={() => commit(i)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] transition-colors ${
                  i === active ? "bg-surface-3 text-ink" : "text-ink-2"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {option.dot && <CategoryDot color={option.dot} />}
                  <span className="truncate">{option.label}</span>
                </span>
                {/* Held on every row, not just the chosen one: the menu sizes
                    itself to its content, so a check that came and went would
                    resize the whole menu as the selection moved. */}
                <span className={i === selected ? "text-accent" : "invisible"} aria-hidden="true">✓</span>
              </button>
            </div>
          ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export function CategoryDot({ color, label }: { color: string; label?: string }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${label ? "cursor-pointer" : ""}`}
      style={{ backgroundColor: color }}
      title={label}
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
