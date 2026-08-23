import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { moveIndex, typeaheadIndex } from "../lib/menuNav";

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

/** A delayed tooltip rendered outside scroll containers so it cannot create
 * overflow or be clipped by the content it describes. */
export function FloatingTooltip({
  text,
  ariaLabel,
  children,
  className = "",
}: {
  text: string;
  /** Accessible name, when it has to differ from the visible tooltip. A label
   *  and its explanation read as one phrase to a screen reader, which has no
   *  layout to tell it they are two things — but folding the label into `text`
   *  to achieve that would print it back onto a tooltip already sitting under
   *  the label it names. */
  ariaLabel?: string;
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
      aria-label={ariaLabel ?? text}
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
          // Above menus, which are above dialogs: a tooltip explains whatever
          // is frontmost, so it can never be the thing that gets covered.
          className="pointer-events-none fixed z-[85] w-52 rounded-lg border border-raised-edge bg-raised px-2.5 py-1.5 text-left text-meta font-normal leading-snug text-ink-2 shadow-menu"
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
  variant?: "default" | "danger" | "quiet-danger" | "primary";
  disabled?: boolean;
  title?: string;
}) {
  /**
   * One resting shape for every variant — `border-edge` over a fill — with hue
   * carried by the fill and the text alone.
   *
   * Two things were wrong before. The border was `edge-2`, the brightest edge
   * the app has and the only place it appeared at rest; MenuSelect reserves
   * that same value for *hover*, so a button sat permanently as bright as a
   * dropdown under the pointer. And with no fill, that border carried the
   * entire signal.
   *
   * Adopting MenuSelect's `border-edge + bg-surface-2` makes buttons and
   * dropdowns one family. Keeping the border neutral on the tinted variants
   * matters as much: a red border *and* a red fill made the danger button
   * differ from its neighbours on two axes at once, which is what made it
   * shout. Now only the hue changes, and `edge-2` means hover again.
   */
  const styles = {
    default: "border-edge bg-surface-2 text-ink-2 hover:border-edge-2 hover:text-ink",
    primary: "border-edge bg-accent/10 text-accent hover:border-accent/40 hover:bg-accent/[.18]",
    danger: "border-edge bg-bad/10 text-bad hover:border-bad/40 hover:bg-bad/[.18]",
    // For a button that *opens* a destructive flow rather than performing one.
    // It rests exactly as an ordinary control does and takes the warning colour
    // only once the pointer is on it — the dialog it raises does the shouting.
    // Reserve the plain `danger` for the button that actually commits.
    "quiet-danger": "border-edge bg-surface-2 text-ink-2 hover:border-bad/40 hover:bg-bad/10 hover:text-bad",
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
      className={`rounded-lg border border-control-edge bg-control px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent/60 ${className}`}
    />
  );
}

export interface MenuOption {
  value: string;
  label: string;
  /** Optional context added only to the closed trigger. Repeating a prefix on
   * every open-menu row makes a short choice list needlessly hard to scan. */
  triggerLabel?: string;
  /** Draws a rule above this entry. Opt-in: only for lists where the break
   *  says something, not as decoration every few rows. */
  divider?: boolean;
  /** Swatch shown before the label, and on the trigger once chosen. */
  dot?: string;
  /** A word about this entry, dimmed and trailing the label — in the list only,
   *  never on the trigger. For marking an entry in place: the alternative is
   *  moving it, and a list whose order answers to state cannot be learned. */
  hint?: string;
}

const MENU_VIEWPORT_MARGIN = 8;

const SIZES = {
  control: "rounded-lg px-2.5 py-1.5 text-xs",
  field: "rounded-[9px] px-2.5 py-2 text-xs",
  compact: "rounded-md px-2 py-1 text-xs",
} as const;

const VARIANTS = {
  default: "border-control-edge bg-control text-ink hover:border-edge-2 focus-visible:border-accent/60",
  quiet: "menu-quiet",
  bare: "border-transparent text-ink-3 hover:bg-surface-3 disabled:hover:bg-transparent",
  resting: "border-control-edge bg-control text-ink-3 hover:border-edge-2 hover:text-ink-2 focus-visible:border-accent/60",
  engaged: "border-accent/45 bg-accent/[.06] text-ink hover:border-accent/65 focus-visible:border-accent/60",
  // Deliberately Button's `default` string, weight included. This trigger's
  // neighbours are buttons rather than other fields, and a control that reads
  // as a form input beside them looks disabled next to the verbs it belongs
  // with. Pair with size "control", which is the shape Button draws.
  action: "border-edge bg-surface-2 text-ink-2 font-medium hover:border-edge-2 hover:text-ink",
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
   *  for triggers that read as a row value rather than a form control.
   *
   *  "resting" and "engaged" are the two halves of a filter: a filter set to
   *  "all" is a label for an absence and must not outshout the data it is not
   *  narrowing, while one that *is* narrowing is state the reader has to be
   *  able to see. Pick between them at the call site, which is the only place
   *  that knows which of its values means "no filter".
   *
   *  "action" is for a menu that fires a command and keeps no selection, sat in
   *  a row of buttons: it borrows Button's resting style, and its placeholder —
   *  a verb rather than an empty value — keeps full strength. */
  variant?: "default" | "quiet" | "bare" | "resting" | "engaged" | "action";
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
      const menu = listRef.current;
      // offsetWidth/offsetHeight are the settled layout dimensions. The
      // opening animation begins at scale(.98), so getBoundingClientRect()
      // would under-measure the popup and let its final frame cross the
      // viewport margin.
      const width = menu?.offsetWidth ?? trigger.width;
      const height = menu?.offsetHeight ?? 0;
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
          open ? "border-accent/60 bg-selected-strong text-ink" : VARIANTS[variant]
        } ${className}`}
      >
        {/* A placeholder is normally dimmed because it stands for a value not
            yet chosen. An action menu's placeholder is not that — it is the
            command the control performs, and dimming it permanently is the one
            state this trigger is always in. */}
        <span
          className={`flex min-w-0 items-center gap-1.5 ${
            current || variant === "action" ? "" : "text-ink-3"
          }`}
        >
          {current ? (
            <>
              {current.dot && <CategoryDot color={current.dot} />}
              <span className="truncate">{current.triggerLabel ?? current.label}</span>
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
            boxSizing: "border-box",
            // Hidden for the frame between mount and measurement, so the menu
            // never flashes at the top-left corner.
            visibility: box ? "visible" : "hidden",
          }}
          // Above the dialog layer (z-70): a menu belongs on top of whatever
          // opened it, and these are used inside modals as well as on the page.
          className="menu-pop fixed z-[80] rounded-[11px] border border-raised-edge bg-raised p-1 shadow-menu"
        >
          {/* The popup is a raised fill, so its two text ranks take the -raised
              inks. This is the pair's motivating case: the header sits directly
              above the rows, and plain ink-3 on dark is lighter than the raised
              ink-2 beneath it — the two ranks would read inverted. */}
          {header && (
            <p className="px-2.5 py-1.5 text-xs leading-snug text-ink-3-raised">{header}</p>
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
                className={`flex w-full items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                  i === active ? "bg-selected-strong text-ink" : "text-ink-2-raised"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {option.dot && <CategoryDot color={option.dot} />}
                  <span className="truncate">{option.label}</span>
                  {option.hint && <span className="shrink-0 text-micro text-ink-3">{option.hint}</span>}
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

export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-ink-2">{label}</div>
  );
}
