import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { moveIndex, typeaheadIndex } from "../../lib/menuNav";
import { CategoryDot } from "./Dots";

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
  /** A destructive entry in an action menu: drawn in the warning colour. */
  danger?: boolean;
  /** Starts a labelled group at this entry, drawn as the Insights scope
   *  picker draws its sections. The label is not an option, so arrow keys
   *  and typeahead pass over it. */
  section?: string;
  /** Overrides the single-value check, for a menu holding several independent
   *  choices — one per section — behind one trigger. */
  checked?: boolean;
}

export const MENU_VIEWPORT_MARGIN = 8;

export const MENU_SIZES = {
  control: "rounded-lg px-2.5 py-1.5 text-xs",
  field: "rounded-[9px] px-2.5 py-2 text-xs",
  compact: "rounded-md px-2 py-1 text-xs",
  // A trigger set into a line of text, such as a table row's metadata. The
  // negative margins give back the padding and border, so the words sit where
  // plain text would and only the hover fill shows it is a control.
  inline: "-mx-[5px] -my-px rounded px-1 py-0 text-xs",
} as const;

export const MENU_VARIANTS = {
  default: "border-control-edge bg-control text-ink hover:border-edge-2 focus-visible:border-accent/60",
  quiet: "menu-quiet",
  bare: "border-transparent text-ink-3 hover:bg-surface-3 disabled:hover:bg-transparent",
  resting: "border-control-edge bg-control text-ink-3 hover:border-edge-2 hover:text-ink-2 focus-visible:border-accent/60",
  engaged: "border-accent/45 bg-accent/[.06] text-ink hover:border-accent/65 focus-visible:border-accent/60",
  // An action menu beside Button's `text` variant, drawn the same way. Its
  // neighbours are buttons rather than other fields, and a control that read as
  // a form input beside them would look disabled next to the verbs it belongs
  // with. Pair with size "control", which is the shape Button draws.
  "text-action": "border-transparent text-ink-2 font-semibold hover:bg-hover-2 hover:text-accent",
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
  triggerDot = true,
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
   *  "text-action" is for a menu that fires a command and keeps no selection,
   *  sat in a row of buttons: it borrows Button's `text` style, and its
   *  placeholder — a verb rather than an empty value — keeps full strength. */
  variant?: "default" | "quiet" | "bare" | "resting" | "engaged" | "text-action";
  /** "field" matches the taller text inputs, for menus that sit in a row
   *  beside one. Passing the padding through className instead would leave
   *  which utility wins up to Tailwind's ordering rather than the call site. */
  size?: "control" | "field" | "compact" | "inline";
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
  /** False keeps the option dots in the menu but leaves them off the
   *  trigger, for a row that already carries a colored mark of its own. */
  triggerDot?: boolean;
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
        className={`flex items-center justify-between gap-2 border outline-none transition-colors disabled:cursor-not-allowed ${MENU_SIZES[size]} ${
          open ? "border-accent/60 bg-selected-strong text-ink" : MENU_VARIANTS[variant]
        } ${className}`}
      >
        {/* A placeholder is normally dimmed because it stands for a value not
            yet chosen. An action menu's placeholder is not that — it is the
            command the control performs, and dimming it permanently is the one
            state this trigger is always in. */}
        <span
          className={`flex min-w-0 items-center gap-1.5 ${
            current || variant === "text-action" ? "" : "text-ink-3"
          }`}
        >
          {current ? (
            <>
              {triggerDot && current.dot && <CategoryDot color={current.dot} />}
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
          {options.map((option, i) => {
            const checked = option.checked ?? i === selected;
            return (
            <div key={option.value}>
              {option.divider && <div className="mx-1.5 my-1 h-px bg-edge" />}
              {option.section && (
                <p
                  role="presentation"
                  className={`px-2.5 pb-1 pt-2.5 text-micro font-medium uppercase tracking-[0.08em] text-ink-3-raised ${
                    i > 0 ? "mt-1.5 border-t border-raised-edge" : "pt-1.5"
                  }`}
                >
                  {option.section}
                </p>
              )}
              <button
                type="button"
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={checked}
                onClick={() => commit(i)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                  option.danger
                    ? i === active ? "bg-bad/10 text-bad" : "text-bad"
                    : i === active ? "bg-selected-strong text-ink" : "text-ink-2-raised"
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
                <span className={checked ? "text-accent" : "invisible"} aria-hidden="true">✓</span>
              </button>
            </div>
            );
          })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
