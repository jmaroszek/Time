import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  CategoryDot,
  MENU_SIZES,
  MENU_VARIANTS,
  MENU_VIEWPORT_MARGIN,
} from "../../components/ui";
import { uncategorizedMark } from "../../lib/chartTheme";
import { fmtDuration } from "../../lib/format";
import {
  scopeKey,
  searchScopeCandidates,
  type InsightsScope,
  type ScopeCandidate,
  type ScopeCandidates,
} from "../../lib/insightsScope";
import { useMeta } from "../../state/meta";

/** Rows per section before anything is typed. Categories are few and are the
 *  usual way in, so all of them fit; apps and websites show their heaviest. */
const BROWSE_LIMITS = { categories: 20, apps: 6, websites: 6 };
/** Enough rows to find the one meant, few enough to read. */
const SEARCH_LIMITS = { categories: 20, apps: 25, websites: 25 };
const POPOVER_WIDTH = 288;

type PickerOption = {
  /** Null clears the scope. */
  scope: InsightsScope | null;
  label: string;
  seconds: number | null;
  color: string | null;
};

const SECTION_LABELS = {
  categories: "Categories",
  apps: "Apps",
  websites: "Websites",
} as const;

/**
 * Narrows Insights to any app, website, or category, by name.
 *
 * The ranked lists only reach what made the top of this range, and Activity's
 * "View in Insights" needs a detour; this reaches anything with time in range
 * from where the date range is chosen, since the two together decide what the
 * page is about.
 *
 * Its options are a pass over every session in range, so they are gathered
 * when the menu opens rather than on every render of the page beneath it.
 */
export default function ScopePicker({
  scope,
  getCandidates,
  onSelect,
  compact = false,
}: {
  scope: InsightsScope | null;
  getCandidates: () => ScopeCandidates;
  onSelect: (scope: InsightsScope | null) => void;
  /** Icon only, for a header too narrow to spare the label. */
  compact?: boolean;
}) {
  const meta = useMeta();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [candidates, setCandidates] = useState<ScopeCandidates | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const currentKey = scope ? scopeKey(scope) : null;
  const label = scope ? scope.name : "All activity";

  const sections = useMemo(() => {
    if (!candidates) return [];
    const found = searchScopeCandidates(candidates, query, query.trim() ? SEARCH_LIMITS : BROWSE_LIMITS);
    const toOption = (candidate: ScopeCandidate): PickerOption => ({
      scope: candidate.scope,
      label: candidate.scope.name,
      seconds: candidate.seconds,
      color: candidate.category?.color ?? uncategorizedMark(meta.theme),
    });
    return (["categories", "apps", "websites"] as const)
      .map((section) => ({ section, options: found[section].map(toOption) }))
      .filter(({ options }) => options.length > 0);
  }, [candidates, query, meta.theme]);
  // The way back out heads the list whenever nothing is being searched for.
  const options = useMemo<PickerOption[]>(() => [
    ...(query.trim() ? [] : [{ scope: null, label: "All activity", seconds: null, color: null }]),
    ...sections.flatMap(({ options: sectionOptions }) => sectionOptions),
  ], [sections, query]);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };
  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    close();
    onSelect(option.scope);
  };
  const openMenu = () => {
    setCandidates(getCandidates());
    setQuery("");
    setActive(0);
    setOpen(true);
  };

  // Opening lands on whatever is shown now, so Enter alone confirms it and the
  // arrows move from it rather than from the top of a long list.
  useEffect(() => {
    if (!open || query.trim()) return;
    const at = options.findIndex((option) =>
      (option.scope ? scopeKey(option.scope) : null) === currentKey);
    setActive(Math.max(at, 0));
  }, [open, candidates]);

  // Not on open alone: the popover stays hidden until it has been measured and
  // placed, and a hidden field cannot take focus.
  const placed = box !== null;
  useEffect(() => {
    if (open && placed) inputRef.current?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
      const top = trigger.bottom + 5;
      setBox({
        left: Math.max(
          MENU_VIEWPORT_MARGIN,
          Math.min(trigger.right - width, window.innerWidth - width - MENU_VIEWPORT_MARGIN),
        ),
        top,
        maxHeight: Math.max(160, window.innerHeight - top - MENU_VIEWPORT_MARGIN),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // Kept from anything listening further up — this Escape is the menu's.
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(active);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      setActive((current) => event.key === "ArrowDown"
        ? Math.min(current + 1, options.length - 1)
        : Math.max(current - 1, 0));
    }
  };

  let optionIndex = query.trim() ? 0 : 1;
  const renderOption = (option: PickerOption, index: number) => {
    const selected = (option.scope ? scopeKey(option.scope) : null) === currentKey;
    return (
      <button
        key={option.scope ? scopeKey(option.scope) : "all"}
        type="button"
        id={`${id}-opt-${index}`}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={() => commit(index)}
        onMouseEnter={() => setActive(index)}
        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
          index === active ? "bg-selected-strong text-ink" : "text-ink-2-raised"
        }`}
      >
        {option.color
          ? <CategoryDot color={option.color} />
          : <span aria-hidden="true" className="h-2 w-2 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
        {option.seconds !== null && (
          <span className="shrink-0 tabular-nums text-ink-3-raised">{fmtDuration(option.seconds)}</span>
        )}
        <span className={`w-3 shrink-0 text-center ${selected ? "text-accent" : "invisible"}`} aria-hidden="true">✓</span>
      </button>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={compact ? `Narrow Insights: ${label}` : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openMenu();
          }
        }}
        className={`flex min-w-0 items-center gap-1.5 border shadow-control outline-none transition-colors ${MENU_SIZES.control} ${
          open
            ? "border-accent/60 bg-selected-strong text-ink"
            : scope ? MENU_VARIANTS.engaged : MENU_VARIANTS.resting
        } ${compact ? "" : "max-w-[11rem]"}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="sr-only">Narrow Insights: </span>
        <span className={compact ? "sr-only" : "min-w-0 truncate"}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Narrow Insights to one app, website, or category"
          style={{
            left: box?.left ?? 0,
            top: box?.top ?? 0,
            width: Math.min(POPOVER_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2),
            maxHeight: box?.maxHeight,
            visibility: box ? "visible" : "hidden",
          }}
          className="menu-pop fixed z-[80] flex flex-col rounded-[11px] border border-raised-edge bg-raised p-1 shadow-menu"
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={options.length > 0 ? `${id}-opt-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Find an app, website, or category"
            placeholder="Find an app, website, or category"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            className="m-1 shrink-0 rounded-md border border-control-edge bg-control px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent/60"
          />
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="Apps, websites, and categories"
            className="min-h-0 overflow-y-auto"
          >
            {!query.trim() && renderOption(options[0], 0)}
            {sections.map(({ section, options: sectionOptions }) => (
              <div key={section} role="group" aria-label={SECTION_LABELS[section]}>
                <p
                  role="presentation"
                  className="px-2.5 pb-1 pt-2.5 text-micro font-medium uppercase tracking-wide text-ink-3-raised"
                >
                  {SECTION_LABELS[section]}
                </p>
                {sectionOptions.map((option) => renderOption(option, optionIndex++))}
              </div>
            ))}
            {query.trim() && options.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-ink-3-raised">
                Nothing with time in this range matches “{query.trim()}”.
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
