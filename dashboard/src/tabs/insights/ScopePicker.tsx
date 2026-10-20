import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  MENU_VIEWPORT_MARGIN,
  StateDot,
} from "../../components/ui";
import type { Category, Productivity } from "../../lib/classify";
import { fmtDuration } from "../../lib/format";
import {
  parentScope,
  scopeDescriptor,
  scopeKey,
  matchedIdentity,
  searchScopeCandidates,
  type InsightsScope,
  type ScopeCandidate,
  type ScopeCandidates,
} from "../../lib/insightsScope";
import { useMeta } from "../../state/meta";

/** Rows per section before anything is typed. Every category, since they are
 *  few and are the usual way in; apps and websites show their heaviest. */
const BROWSE_LIMITS = { categories: Infinity, apps: 5, websites: 5 };
/** Enough rows to find the one meant, few enough to read. */
const SEARCH_LIMITS = { categories: Infinity, apps: 25, websites: 25 };
const POPOVER_WIDTH = 288;

type PickerOption = {
  scope: InsightsScope;
  label: string;
  /** The executable or host a search found this by, when not its name. */
  matched: string | null;
  seconds: number;
};

const SECTION_LABELS = {
  categories: "Categories",
  apps: "Apps",
  websites: "Websites",
} as const;

/**
 * Narrows Insights to any app, website, or category, by name, and says what the
 * page is narrowed to.
 *
 * It sits beside the tabs. Unscoped it is only a magnifier; scoped it grows to
 * name the subject, with its productivity dot, which makes it the page's
 * heading as well as the way to change it, so the subject is stated once, in
 * the header, rather than in a row of its own above the tiles. The menu's rows
 * carry no dots: a wall of them is noise when picking by name. An app or website held inside a category shows
 * that category ahead of its name, and the category goes back one step to it;
 * the clear button goes all the way out, which is why the list itself has no
 * "All activity" row.
 *
 * The ranked lists only reach what made the top of this range, and Activity's
 * "View in Insights" needs a detour; this reaches anything with time in range.
 *
 * Its options are a pass over every session in range, so they are gathered
 * when the menu opens rather than on every render of the page beneath it.
 */
export default function ScopePicker({
  scope,
  category,
  states,
  getCandidates,
  onSelect,
}: {
  scope: InsightsScope | null;
  /** Every productivity state the scope's categorized time is in. */
  states: Productivity[];
  /** The scope's own category, or the one most of an app's time resolved to. */
  category: Category | null;
  getCandidates: () => ScopeCandidates;
  onSelect: (scope: InsightsScope | null) => void;
}) {
  const meta = useMeta();
  const id = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [candidates, setCandidates] = useState<ScopeCandidates | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const currentKey = scope ? scopeKey(scope) : null;
  const parent = scope ? parentScope(scope) : null;
  const descriptor = scope ? scopeDescriptor(scope, category) : null;
  const stateColor = (kind: Productivity) => meta.palette[kind];

  const sections = useMemo(() => {
    if (!candidates) return [];
    const found = searchScopeCandidates(candidates, query, query.trim() ? SEARCH_LIMITS : BROWSE_LIMITS);
    const toOption = (candidate: ScopeCandidate): PickerOption => ({
      scope: candidate.scope,
      label: candidate.scope.name,
      matched: matchedIdentity(candidate, query),
      seconds: candidate.seconds,
    });
    return (["categories", "apps", "websites"] as const)
      .map((section) => ({ section, options: found[section].map(toOption) }))
      .filter(({ options }) => options.length > 0);
  }, [candidates, query]);
  const options = useMemo<PickerOption[]>(
    () => sections.flatMap(({ options: sectionOptions }) => sectionOptions),
    [sections],
  );

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
    const at = options.findIndex((option) => scopeKey(option.scope) === currentKey);
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
      const trigger = shellRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
      const top = trigger.bottom + 5;
      setBox({
        left: Math.max(
          MENU_VIEWPORT_MARGIN,
          Math.min(trigger.left, window.innerWidth - width - MENU_VIEWPORT_MARGIN),
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
      if (popoverRef.current?.contains(target) || shellRef.current?.contains(target)) return;
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

  let optionIndex = 0;
  const renderOption = (option: PickerOption, index: number) => {
    const selected = scopeKey(option.scope) === currentKey;
    return (
      <button
        key={scopeKey(option.scope)}
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
        <span className="min-w-0 flex-1 truncate">
          {option.label}
          {option.matched && <span className="ml-1.5 text-ink-3-raised">{option.matched}</span>}
        </span>
        <span className="shrink-0 tabular-nums text-ink-3-raised">{fmtDuration(option.seconds)}</span>
        <span className={`w-3 shrink-0 text-center ${selected ? "text-accent" : "invisible"}`} aria-hidden="true">✓</span>
      </button>
    );
  };

  const ring = "outline-none focus-visible:ring-1 focus-visible:ring-accent/60";
  return (
    <>
      {/* The tab bar's own shell, so the two read as one row of chrome. */}
      <div
        ref={shellRef}
        className={`flex min-w-0 items-center gap-0.5 rounded-xl border bg-surface p-1 transition-colors ${
          open ? "border-accent/60" : "border-edge"
        }`}
      >
        {parent && (
          <>
            <button
              type="button"
              onClick={() => onSelect(parent)}
              title={`Back to ${parent.name}`}
              className={`min-w-0 max-w-[8rem] shrink truncate rounded-lg px-2 py-1.5 text-xs text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink ${ring}`}
            >
              {parent.name}
            </button>
            <span aria-hidden="true" className="shrink-0 text-xs text-ink-3">›</span>
          </>
        )}
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Narrow Insights: ${scope ? scope.name : "All activity"}`}
          title={scope ? `${scope.name} · Change` : "Narrow Insights to one app, website, or category"}
          onClick={() => (open ? close() : openMenu())}
          onKeyDown={(event) => {
            if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              openMenu();
            }
          }}
          className={`flex min-w-0 items-center gap-2 rounded-lg py-1.5 text-xs transition-colors hover:bg-surface-3 ${ring} ${
            scope ? "px-2.5 text-ink" : "px-2 text-ink-2 hover:text-ink"
          } ${open ? "bg-selected" : ""}`}
        >
          {scope ? (
            <>
              <StateDot colors={states.map(stateColor)} />
              <span className="min-w-0 truncate font-semibold">{scope.name}</span>
              <span className="shrink-0 text-ink-3">{descriptor}</span>
            </>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          )}
        </button>
        {scope && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-label="Show all activity"
            title="Show all activity"
            className={`shrink-0 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink ${ring}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
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
            {sections.map(({ section, options: sectionOptions }, sectionIndex) => (
              <div
                key={section}
                role="group"
                aria-label={SECTION_LABELS[section]}
                className={sectionIndex > 0 ? "mt-1.5 border-t border-raised-edge" : ""}
              >
                <p
                  role="presentation"
                  className="px-2.5 pb-1 pt-2.5 text-micro font-medium uppercase tracking-[0.08em] text-ink-3-raised"
                >
                  {SECTION_LABELS[section]}
                </p>
                {sectionOptions.map((option) => renderOption(option, optionIndex++))}
              </div>
            ))}
            {options.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-ink-3-raised">
                {query.trim()
                  ? <>Nothing with time in this range matches “{query.trim()}”.</>
                  : "Nothing recorded in this range."}
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
