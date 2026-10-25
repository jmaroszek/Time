import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  Button,
  CategoryDot,
  Checkbox,
  MenuSelect,
} from "../../components/ui";
import {
  type ActivityDayBucket,
  type ActivityEntitySummary,
  type ActivitySortDirection,
  type ActivityTitleGroup,
  type ActivityTitleGroupPage,
  type ActivityWindowSort,
} from "../../lib/activity";
import {
  appSuffixNames,
  countNoun,
  entityClassification,
  formatSharePercent,
  formatDateTime,
  formatLastSeen,
  formatCompactDate,
  formatVisitDay,
  groupVisitsByDay,
  trimAppSuffix,
  visitEditLabel,
  windowGroupClassification,
  windowRowCategory,
} from "../../lib/activityFormat";
import { type Category, type Rule } from "../../lib/classify";
import { uncategorizedMark } from "../../lib/chartTheme";
import { fmtDuration, fmtDurationTitle } from "../../lib/format";
import { useMeta } from "../../state/meta";
import { LoadMore } from "./ActivityFeedback";
import Chevron from "./Chevron";
import ClearableInput from "./ClearableInput";
import MatchedTitle from "./MatchedTitle";
import ShareBar from "./ShareBar";
import { RowTag } from "./ActivityTables";
import { categoryDestinationOptions } from "./menuOptions";
import { AUTOMATIC_CLASSIFICATION, RULE_LABELS } from "./ruleComposer";

/** Hidden until its row is pointed at or focused, or a selection exists — the
 *  Windows list's rule, for the same reason: a column of empty boxes down every
 *  visit was the loudest thing in a list most people only read. */
function revealBox(group: "day" | "visit", selectionActive: boolean, actionsDisabled: boolean) {
  const reveal = group === "day"
    ? "opacity-0 group-hover/day:opacity-100 group-has-[:focus-visible]/day:opacity-100"
    : "opacity-0 group-hover/visit:opacity-100 group-has-[:focus-visible]/visit:opacity-100";
  return `shrink-0 transition-opacity ${selectionActive ? "" : reveal} ${
    actionsDisabled ? "pointer-events-none opacity-50" : ""
  }`;
}

function GroupSessions({
  group,
  selected,
  actionsDisabled,
  onToggle,
  onToggleMany,
  onEdit,
  onLoadMore,
}: {
  group: ActivityTitleGroup;
  selected: Set<number>;
  actionsDisabled: boolean;
  onToggle: (id: number) => void;
  onToggleMany: (ids: number[]) => void;
  onEdit: (id: number) => void;
  onLoadMore: () => void;
}) {
  const selectionActive = selected.size > 0;
  return (
    <div className="flex flex-col">
      {/* The date is shown once per day; each visit row carries its time. */}
      {groupVisitsByDay(group.sessions).map((day) => {
        const dayIds = day.visits.map((visit) => visit.id);
        const wholeDay = dayIds.every((id) => selected.has(id));
        return (
        <div key={day.key} className="mt-4 flex flex-col first:mt-0">
          {/* The box and the date are separate so hiding one leaves the other.
              This checkbox covers only the visits loaded for this day. */}
          <div className="group/day flex items-center gap-2 px-1.5 pb-1 text-micro uppercase tracking-[.04em] text-ink-3">
            <Checkbox
              checked={wholeDay}
              indeterminate={dayIds.some((id) => selected.has(id))}
              onChange={actionsDisabled ? () => undefined : () => onToggleMany(dayIds)}
              label={`Select the ${countNoun(dayIds.length, "visit")} shown on ${formatVisitDay(day.visits[0].start)}`}
              className={revealBox("day", selectionActive, actionsDisabled)}
            />
            <span>{formatVisitDay(day.visits[0].start)}</span>
          </div>
          {day.visits.map((session) => {
            const edited = visitEditLabel(session);
            const ticked = selected.has(session.id);
            return (
            <div
              key={session.id}
              className={`group/visit flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors ${
                ticked ? "bg-accent/[.09]" : "hover:bg-hover"
              }`}
            >
              <Checkbox
                checked={ticked}
                onChange={actionsDisabled ? () => undefined : () => onToggle(session.id)}
                label={`Select the visit starting ${formatDateTime(session.start)}`}
                className={revealBox("visit", selectionActive, actionsDisabled)}
              />
              <span className="w-[62px] shrink-0 tabular-nums text-ink-2">
                {new Date(session.start * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="shrink-0 tabular-nums text-ink-3">
                {fmtDuration(session.seconds)}
              </span>
              {/* Keep the status tag and Edit control anchored at the right so
                  rows without a status do not shift the shared control. */}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {edited && (
                  <span className="rounded-full bg-accent/10 px-1.5 py-[1px] text-xs text-accent">
                    {edited}
                  </span>
                )}
                {/* Hidden until the row is pointed at or focused: a word on all
                    of a hundred rows read as part of every row's data. */}
                <button
                  type="button"
                  onClick={() => onEdit(session.id)}
                  disabled={actionsDisabled}
                  title="Edit visit"
                  aria-label={`Edit the visit starting ${formatDateTime(session.start)}`}
                  className="flex h-5 w-5 items-center justify-center rounded text-ink-3 opacity-0 transition-opacity hover:bg-hover-2 hover:text-accent focus-visible:opacity-100 group-hover/visit:opacity-100 disabled:cursor-default disabled:opacity-40"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </span>
            </div>
            );
          })}
        </div>
        );
      })}
      {group.sessionCount > group.sessions.length && (
        // Keep paged visits actionable instead of silently truncating the group.
        <LoadMore
          shown={group.sessions.length}
          total={group.sessionCount}
          onClick={onLoadMore}
          disabled={actionsDisabled}
        />
      )}
    </div>
  );
}
/**
 * A matching stored title is highlighted and kept within the row width.
 */
/** Exclusions are per-entity curation, like corrections and deletions, so they
 *  live beside them instead of behind a second CRUD surface in Settings. */
/**
 * The undocked panel's column. Undocked, the panel takes the card's place, and
 * at the card's full width its bars and rows stretched to a thousand pixels for
 * a list read at a glance. Capped near the docked panel's width and kept left,
 * under the view switcher, the way Categories caps its own column. The
 * tab gives anything above the panel the same width.
 */
export const DETAIL_PANEL_DRILL_IN_WIDTH = "mr-auto w-full max-w-[720px]";

/**
 * The shell both Activity panels sit in.
 *
 * It is an inspector, not a dialog: the source list remains live behind it.
 * Escape and arrow navigation are wired at the tab, which owns row order.
 *
 * Both panels use this shell so their landmarks, spacing, and controls stay
 * consistent.
 */
function DetailPanel({
  label,
  dock,
  eyebrow,
  heading,
  subtitle,
  onBack,
  backLabel,
  onClose,
  closeLabel,
  children,
}: {
  /** Names the landmark. A string rather than a reference to the heading,
   *  because the heading is an editable field while a rename is in progress
   *  and would name the panel by a half-typed draft. */
  label: string;
  /** Measured position in the page's right margin. Null on a window too narrow
   *  to dock into, where the panel falls back to stacking under the table. */
  dock: CSSProperties | null;
  eyebrow: ReactNode;
  heading: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      style={dock ?? undefined}
      className={`panel-in flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-edge bg-surface ${
        dock
          ? "z-30"
          : `h-full flex-1 ${DETAIL_PANEL_DRILL_IN_WIDTH}`
      }`}
    >
      <div className="shrink-0 border-b border-edge">
        {/* Both controls use matched SVG geometry. Mixing a text ✕ with an icon
            makes their apparent alignment move with font and DPI scaling. */}
        {onBack && (
          <div className="flex items-center justify-between px-4 pt-3 sm:px-5">
            <button
              type="button"
              onClick={onBack}
              title={backLabel}
              aria-label={backLabel}
              className="-ml-1.5 flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 12H5m7-7-7 7 7 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onClose}
              title={`${closeLabel} (Esc)`}
              aria-label={closeLabel}
              className="-mr-1.5 flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className={`flex items-start gap-3 px-4 sm:px-5 ${onBack ? "pb-4 pt-1" : "py-4"}`}>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-micro uppercase tracking-[.05em] text-ink-3">
              {eyebrow}
            </div>
            {heading}
            {subtitle}
          </div>
          {!onBack && (
            <button
              type="button"
              onClick={onClose}
              title={`${closeLabel} (Esc)`}
              aria-label={closeLabel}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {/* The top padding belongs to the content, not the scroll box. A sticky
          heading with `top: 0` pins to the scroll container's *content* box, so
          a padded container parks it that far down the scrollport and leaves a
          band above it — exactly 16px of it — through which the rows below
          scrolled in full view. Horizontal padding is unaffected and stays
          here, where the sticky headings' -mx-5 bleed still relies on it. */}
      <div className="scroll-well min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-5">
        <div className="pt-4">{children}</div>
      </div>
    </aside>
  );
}

/** A panel section. The heading level is fixed here so the two panels cannot
 *  drift apart on the one thing a screen reader navigates them by. */
function PanelSection({
  title,
  right,
  children,
  className = "mt-8",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  /** Replaces the default gap rather than adding to it, so a section that
   *  opens the panel can sit flush with its top. */
  className?: string;
}) {
  return (
    // The card-title step, not the row step: at 13px beside 12px rows and
    // controls these read as one more line of body copy, and they are the
    // panel's only landmarks once the header is out of view.
    <section className={className}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * The category a window row is worth labelling with.
 *
 * Inside one app's panel nearly every window resolves the way the app does, so
 * printing "AI" against each of Claude's windows repeats a fact the
 * Classification section states once, twenty rows running. Null means "same as
 * the app, say nothing", which turns the label into a signal: it shows up only
 * where a Window rule or a correction has pulled one window somewhere else.
 *
 * The baseline is null when the entity has no single category of its own, and
 * then every row is worth labelling — that is exactly the case where they
 * differ from each other.
 */
/**
 * One Window in an entity's list.
 *
 * The row is a checkbox beside a button rather than one whole-row button: a
 * checkbox cannot be nested inside a button, and the two do different things —
 * one opens the Window, the other enrols every visit it stands for in a batch.
 * The hover and selection tint therefore belong to the wrapper, so the row
 * still lights as one object whichever half the pointer is over.
 *
 * A divided list rather than a stack of bordered cards: inside a bordered panel
 * each card was a box in a box, and forty of them read as one striped block.
 * Visits and last-seen ride in the tooltip. They describe a window someone has
 * already picked out, which is what opening it is for.
 */
function PanelWindowRow({
  group,
  appNames,
  search,
  maxSeconds,
  totalSeconds,
  category,
  selectable,
  selectionActive,
  selected,
  actionsDisabled,
  onToggle,
  onOpen,
}: {
  group: ActivityTitleGroup;
  /** What the app's own title suffix can spell, for trimming it off. */
  appNames: string[];
  search: string;
  maxSeconds: number;
  totalSeconds: number;
  /** Null when it matches the app's own, and so is not worth the words. */
  category: string | null;
  /** False in the preview, which is for reading rather than batch work. */
  selectable: boolean;
  /** Any row is ticked, so every box shows instead of waiting for hover. */
  selectionActive: boolean;
  selected: boolean;
  actionsDisabled: boolean;
  onToggle: (group: ActivityTitleGroup) => void;
  onOpen: (group: ActivityTitleGroup) => void;
}) {
  const trimmed = trimAppSuffix(group.title, appNames);
  // A search can match only inside the trimmed tail ("obsidian"), and a row
  // listed for a match it does not show reads as a wrong result.
  const shownTitle = search && !trimmed.toLowerCase().includes(search.toLowerCase())
    ? group.title
    : trimmed;
  const tooltip = [
    group.title || "No title recorded",
    `${countNoun(group.sessionCount, "visit")} · last seen ${formatLastSeen(group.lastSeen)}`,
  ].join("\n");
  return (
    <div
      // The tint the catalog table already uses for a selected row, and only
      // that: the tick states the selection, so a second accent says it twice.
      className={`group/row flex items-start gap-2 rounded-lg border-t border-edge/50 px-1.5 py-2 transition-colors first:border-t-0 ${
        selected ? "bg-accent/[.09]" : "hover:bg-hover"
      }`}
    >
      {/* Present but invisible until the row is pointed at or focused, or a
          selection exists: a column of empty boxes down every row was the
          loudest thing in a list most people only read. Keyboard focus only —
          a clicked box keeps focus, so plain focus-within left an emptied box
          showing after the pointer had gone until something else was clicked. */}
      {selectable && (
        <Checkbox
          checked={selected}
          onChange={actionsDisabled ? () => undefined : () => onToggle(group)}
          label={`Select every visit to ${group.title || "this untitled window"}`}
          className={`mt-px shrink-0 transition-opacity ${
            selectionActive
              ? ""
              : "opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100"
          } ${actionsDisabled ? "pointer-events-none opacity-50" : ""}`}
        />
      )}
      <button
        type="button"
        onClick={() => onOpen(group)}
        title={tooltip}
        className="min-w-0 flex-1 text-left text-xs outline-none"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ink-2">
            {/* Title capture can be switched on part way through a history, so
                one app can hold both kinds of row. A bare em dash left the
                untitled one looking like a rendering fault rather than a fact. */}
            {group.title
              ? <MatchedTitle title={shownTitle} search={search} tooltip={tooltip} />
              : <span className="italic text-ink-3">No title recorded</span>}
          </span>
          {category !== null && (
            <span className="max-w-[40%] shrink-0 truncate text-ink-3">{category}</span>
          )}
          <span className="shrink-0 tabular-nums text-ink-3" title={fmtDurationTitle(group.seconds)}>{fmtDuration(group.seconds)}</span>
          {/* The row opens something. Without this it read as a static summary,
              and the only hint otherwise was the cursor. */}
          <Chevron open={false} />
        </span>
        {/* The same bar the library table draws, against the heaviest window this
            app has rather than the heaviest row on screen — so it does not
            rescale when the list is re-sorted or extended. */}
        <span className="mt-1.5 block">
          <ShareBar seconds={group.seconds} maxSeconds={maxSeconds} totalSeconds={totalSeconds} />
        </span>
      </button>
    </div>
  );
}

/** The window's classification as one line: the category with its dot, then
 *  what decided it. Mixed has no single color to show, so it gets no dot. */
function windowClassificationLine(group: ActivityTitleGroup, uncategorizedColor: string) {
  const { label, detail } = windowGroupClassification(group);
  const color = group.mixed
    ? null
    : group.categoryName === null && !group.allIgnored
      ? uncategorizedColor
      : group.categoryColor;
  return { label, detail, color };
}

export function WindowPanel({
  dock,
  group,
  usage,
  onLoadMoreVisits,
  selectedSessionIds,
  onToggleSession,
  onToggleAllSessions,
  onClassifySelected,
  onDeleteSelected,
  onEditSession,
  categories,
  onMakeRule,
  onOpenParent,
  onBack,
  onClose,
  actionsDisabled = false,
}: {
  dock: CSSProperties | null;
  group: ActivityTitleGroup;
  usage: ActivityDayBucket[];
  onLoadMoreVisits: () => void;
  selectedSessionIds: Set<number>;
  onToggleSession: (id: number) => void;
  onToggleAllSessions: (ids: number[]) => void;
  /** Null returns the ticked visits to whatever the rules decide. */
  onClassifySelected: (categoryId: number | null) => void;
  onDeleteSelected: () => void;
  onEditSession: (id: number) => void;
  categories: Category[];
  onMakeRule: (group: ActivityTitleGroup) => void;
  onOpenParent: () => void;
  onBack?: () => void;
  onClose: () => void;
  /** The result is stale while a replacement worker query is in flight. */
  actionsDisabled?: boolean;
}) {
  const { theme } = useMeta();
  const classification = windowClassificationLine(group, uncategorizedMark(theme));
  const allSelected = group.sessionIds.every((id) => selectedSessionIds.has(id));
  return (
    <DetailPanel
      dock={dock}
      label={`Window details: ${group.title || "no title recorded"}`}
      eyebrow={
        <>
          <span>Window</span>
          {group.isNew && (
            <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
          )}
        </>
      }
      heading={
        <h2 className="copyable break-words text-lg font-semibold">
          {group.title || <span className="italic text-ink-3">No title recorded</span>}
        </h2>
      }
      subtitle={
        // This link expresses hierarchy and is always available. The arrow is
        // separate: it appears only when this Window was opened from here.
        <p className="truncate text-xs text-ink-3" title={group.entityKey}>
          <button
            type="button"
            onClick={onOpenParent}
            title={`Open ${group.displayName} details`}
            className="rounded-sm underline-offset-2 outline-none transition-colors hover:text-ink-2 hover:underline focus-visible:text-ink-2 focus-visible:underline"
          >
            {group.displayName}
          </button>
          {" · "}<span className="copyable font-mono">{group.entityKey}</span>
        </p>
      }
      onBack={onBack}
      backLabel={`Back to ${group.displayName} details`}
      onClose={onClose}
      closeLabel="Close Window details"
    >
      {/* First in the body, as in the app panel: the one standing decision.
          The category reads as a value, its dot the one the rest of the app
          gives it, and what decided it trails in the muted line's place. The
          rule action sits on the same row as borderless text rather than a
          bordered button pinned to the heading. */}
      <PanelSection title="Classification" className="">
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            {classification.color && <CategoryDot color={classification.color} />}
            <span className="shrink-0 font-medium text-ink">{classification.label}</span>
            <span className="min-w-0 truncate text-ink-3" title={classification.detail}>
              <span aria-hidden="true">· </span>{classification.detail}
            </span>
          </p>
          <span className="-mr-3 shrink-0">
            <Button
              variant="accent"
              disabled={actionsDisabled}
              onClick={() => onMakeRule(group)}
              title="Classify this window, and every window titled like it, with a standing rule."
            >
              Create Window rule
            </Button>
          </span>
        </div>
      </PanelSection>

      {/* No line of facts: the strip shows the days and its caption the
          total, and the first visit row says when it was last seen. */}
      <UsageStrip buckets={usage} seconds={group.seconds} />

      <section className="mt-8">
        <div className="flex flex-wrap items-center gap-2">
          {/* The same header the app panel's Windows list has: one box for the
              whole list, the count beside the heading, batch actions only once
              something is ticked. */}
          <Checkbox
            checked={allSelected}
            indeterminate={selectedSessionIds.size > 0}
            onChange={actionsDisabled ? () => undefined : () => onToggleAllSessions(group.sessionIds)}
            label={allSelected ? "Clear the visit selection" : `Select all ${countNoun(group.sessionCount, "visit")}`}
            className={actionsDisabled ? "pointer-events-none opacity-50" : ""}
          />
          <h3 className="text-sm font-semibold">Visits</h3>
          <span className="mr-auto min-w-0 truncate text-xs tabular-nums text-ink-3">
            {selectedSessionIds.size > 0
              ? `${selectedSessionIds.size} selected`
              : countNoun(group.sessionCount, "visit")}
          </span>
          {selectedSessionIds.size > 0 && (
            <>
              <Button variant="text-danger" disabled={actionsDisabled} onClick={onDeleteSelected}>Delete selected</Button>
              {/* This action writes an override on each selected visit, not a
                  standing rule. */}
              <MenuSelect
                variant="text-action"
                size="control"
                align="end"
                value=""
                placeholder={`Classify ${selectedSessionIds.size}…`}
                label={`Classify the ${countNoun(selectedSessionIds.size, "selected visit")}`}
                disabled={actionsDisabled}
                onChange={(value) =>
                  onClassifySelected(value === AUTOMATIC_CLASSIFICATION ? null : Number(value))}
                options={[
                   // This option also clears the selected visit overrides.
                  { value: AUTOMATIC_CLASSIFICATION, label: "Use automatic classification" },
                  // The prepended entry is the menu's first line, so the
                  // categories that follow all need a divider offset of one:
                  // the rule above Ignored still has something above it, and the
                  // rule below this entry is its own.
                  ...categoryDestinationOptions(categories, null, { dividerOffset: 1 })
                    .map((option, i) => (i === 0 ? { ...option, divider: true } : option)),
                ]}
              />
            </>
          )}
        </div>
        {/* No bordered well: inside the bordered panel it was a box in a box.
            Pulled out by the rows' own padding, so their boxes sit under the
            header's and only the hover tint reaches past it. */}
        <div className="-mx-1.5 mt-3">
          <GroupSessions
            group={group}
            selected={selectedSessionIds}
            actionsDisabled={actionsDisabled}
            onToggle={onToggleSession}
            onToggleMany={onToggleAllSessions}
            onEdit={onEditSession}
            onLoadMore={onLoadMoreVisits}
          />
        </div>
      </section>
    </DetailPanel>
  );
}

/**
 * What decided this entity's classification, in one line.
 *
 * Rule coverage is explicit: a rule can decide only part of an entity's time
 * while manual corrections account for the rest.
 */
/**
 * How an entity's time divides, and what divided it: one row per rule, plus
 * manual corrections and uncategorized time, so the rows always sum to the
 * whole. A per-category legend beside a separate rule list said the same split
 * twice.
 *
 * Rows of one category sit together, so its segments join into one run of
 * color in the bar and its share still reads at a glance.
 */
function ClassificationBreakdown({ entity }: { entity: ActivityEntitySummary }) {
  const { theme } = useMeta();
  const defaultLabel = entity.kind === "website" ? "Website default" : "App default";
  const ruleSecondsByCategory = new Map<number, number>();
  for (const rule of entity.rules) {
    ruleSecondsByCategory.set(rule.categoryId, (ruleSecondsByCategory.get(rule.categoryId) ?? 0) + rule.seconds);
  }
  const rows = entity.categories.flatMap((category) => {
    const ruleRows = entity.rules
      .filter((rule) => rule.categoryId === category.categoryId)
      .map((rule) => ({
        key: `rule:${rule.ruleId}`,
        category: category.name,
        color: category.color,
        source: rule.ruleId === entity.exactRuleId ? defaultLabel : RULE_LABELS[rule.matchType],
        pattern: rule.ruleId === entity.exactRuleId ? null : rule.pattern,
        seconds: rule.seconds,
      }));
    // Whatever a category holds beyond its rules came from corrections.
    const corrected = category.seconds - (ruleSecondsByCategory.get(category.categoryId) ?? 0);
    return corrected > 1
      ? [...ruleRows, {
          key: `corrected:${category.categoryId}`,
          category: category.name,
          color: category.color,
          source: "Manual corrections",
          pattern: null,
          seconds: corrected,
        }]
      : ruleRows;
  });
  if (entity.uncategorizedSeconds > 0) {
    rows.push({
      key: "uncategorized",
      category: "Uncategorized",
      color: uncategorizedMark(theme),
      source: "",
      pattern: null,
      seconds: entity.uncategorizedSeconds,
    });
  }
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  // One row is not a division. Drawing a full-width bar and a row reading
  // "100%" only restates the line directly above it.
  if (total <= 0 || rows.length < 2) return null;
  const share = (seconds: number) => {
    const percent = (seconds / total) * 100;
    return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  };
  return (
    <>
      <span aria-hidden="true" className="mt-5 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-2">
        {rows.map((row) => (
          <span
            key={row.key}
            style={{ width: `${(row.seconds / total) * 100}%`, backgroundColor: row.color }}
          />
        ))}
      </span>
      <div className="mt-3 flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 text-xs">
            <CategoryDot color={row.color} />
            <span className="min-w-0 flex-1 truncate">
              {row.category}
              {row.source && (
                <span className="text-ink-3">
                  {" · "}{row.source}
                  {row.pattern && <> <span className="font-mono" title={row.pattern}>{row.pattern}</span></>}
                </span>
              )}
            </span>
            <span className="tabular-nums text-ink-3" title={fmtDurationTitle(row.seconds)}>{fmtDuration(row.seconds)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-3">{share(row.seconds)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * When the entity was used across the range.
 *
 * No other view answers this for one app: Insights draws every app at once, and
 * a total plus a "days seen" count cannot tell a daily habit from one long
 * week. Columns are the range's calendar days — empty ones included, because a
 * gap is most of what there is to see.
 */
function usageStripPeak(buckets: ActivityDayBucket[]): number | null {
  const peak = buckets.reduce((most, bucket) => Math.max(most, bucket.seconds), 0);
  return buckets.length < 2 || peak <= 0 ? null : peak;
}

function UsageStrip({
  buckets,
  right,
  seconds,
}: {
  buckets: ActivityDayBucket[];
  right?: ReactNode;
  /** Total time in range, for the caption. Nobody can sum the bars by eye,
   *  while the busiest column is the tallest one and its tooltip says it. */
  seconds: number;
}) {
  const peak = usageStripPeak(buckets);
  if (peak === null) return null;
  const spanLabel = (bucket: ActivityDayBucket) => (bucket.days === 1
    ? formatCompactDate(bucket.startSec)
    : `${formatCompactDate(bucket.startSec)} – ${formatCompactDate(bucket.endSec - 1)}`);
  return (
    <section className="mt-8">
      {/* The same word Insights gives the same idea. A section heading naming
          its own chart beats one phrased as the question the chart answers. */}
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">Timeline</h3>
        {right}
      </div>
      <div className="mt-4 flex h-10 items-end gap-px border-b border-edge/70">
        {buckets.map((bucket) => (
          <span
            key={bucket.startSec}
            title={`${spanLabel(bucket)} · ${fmtDuration(bucket.seconds)}`}
            className="flex h-full flex-1 items-end"
          >
            <span
              className="w-full rounded-t-[2px] bg-accent/75"
              // A day with a minute on it still gets a visible mark: the strip
              // is read for whether something happened at all, not for how
              // much. The floor is in pixels because a percentage of a 40px
              // strip drew a hairline that read as a rule, not a bar.
              style={bucket.seconds > 0
                ? { height: `${(bucket.seconds / peak) * 100}%`, minHeight: 4 }
                : { height: 0 }}
            />
          </span>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-ink-3">
        <span>{formatCompactDate(buckets[0].startSec)}</span>
        <span>{fmtDuration(seconds)} in range</span>
        <span>{formatCompactDate(buckets[buckets.length - 1].endSec - 1)}</span>
      </div>
    </section>
  );
}

/** The four orders the window list can take, as one control. Each is a whole
 *  answer ("most time"), not a column plus a direction to work out. */
const WINDOW_ORDERS: { value: string; label: string; sort: ActivityWindowSort; direction: ActivitySortDirection }[] = [
  { value: "seconds:desc", label: "Most time", sort: "seconds", direction: "desc" },
  { value: "lastSeen:desc", label: "Most recent", sort: "lastSeen", direction: "desc" },
  { value: "days:desc", label: "Most days", sort: "days", direction: "desc" },
  { value: "title:asc", label: "Title A–Z", sort: "title", direction: "asc" },
];

export function EntityPanel({
  dock,
  entity,
  groups,
  usage,
  hasStoredTitles,
  detailSearch,
  onDetailSearch,
  detailSort,
  detailDirection,
  onDetailSort,
  onLoadMore,
  windowsExpanded,
  onExpandWindows,
  onCollapseWindows,
  onClose,
  categories,
  rules,
  aliases,
  onDeleteEntity,
  onExclude,
  onOpenWindow,
  selectedWindowKeys,
  onToggleWindow,
  onToggleWindows,
  onClassifyWindows,
  onDeleteWindows,
  onAssign,
  onSaveAlias,
  onViewInInsights,
  titlesStored,
  onStoreTitles,
  actionsDisabled = false,
}: {
  dock: CSSProperties | null;
  entity: ActivityEntitySummary;
  groups: ActivityTitleGroupPage;
  usage: ActivityDayBucket[];
  hasStoredTitles: boolean;
  detailSearch: string;
  onDetailSearch: (value: string) => void;
  detailSort: ActivityWindowSort;
  detailDirection: ActivitySortDirection;
  onDetailSort: (sort: ActivityWindowSort, direction: ActivitySortDirection) => void;
  onLoadMore: () => void;
  /** False shows the short preview: the heaviest few windows and no list
   *  controls. True is the full, filterable, selectable list. */
  windowsExpanded: boolean;
  onExpandWindows: () => void;
  /** Also clears the filter, order and selection that only the full list has
   *  controls for, so the preview never answers to settings it hides. */
  onCollapseWindows: () => void;
  onClose: () => void;
  categories: Category[];
  rules: Rule[];
  aliases: Record<string, string>;
  onDeleteEntity: () => void;
  onExclude: () => void;
  onOpenWindow: (group: ActivityTitleGroup) => void;
  /** Windows whose visits are enrolled in the batch, keyed as the rows are.
   *  Keys rather than session ids so a row can report its own state without
   *  re-deriving it from a set of several hundred numbers on every render. */
  selectedWindowKeys: Set<string>;
  onToggleWindow: (group: ActivityTitleGroup) => void;
  onToggleWindows: (groups: ActivityTitleGroup[]) => void;
  /** Null returns the selected windows' visits to whatever the rules decide. */
  onClassifyWindows: (categoryId: number | null) => void;
  onDeleteWindows: () => void;
  onAssign: (categoryId: number) => Promise<void>;
  onSaveAlias: (alias: string) => Promise<void>;
  /** Opens Insights narrowed to this entity. */
  onViewInInsights?: () => void;
  /** Whether "Store window titles" is on now. Distinct from hasStoredTitles,
   *  which is whether any history has them. */
  titlesStored: boolean;
  /** Opens the setting that turns title storage on. */
  onStoreTitles?: () => void;
  /** The result is stale while a replacement worker query is in flight. */
  actionsDisabled?: boolean;
}) {
  const kindLabel = entity.kind === "website" ? "website" : "app";
  const savedAlias = aliases[entity.key.toLowerCase()] ?? "";
  const [aliasDraft, setAliasDraft] = useState(savedAlias);
  const [renaming, setRenaming] = useState(false);
  const cancelAlias = useRef(false);
  useEffect(() => setAliasDraft(savedAlias), [savedAlias, entity.key]);
  // A rename is about the entity in front of the reader, and the arrow keys can
  // change that without anything being clicked.
  useEffect(() => {
    setRenaming(false);
  }, [entity.id]);
  const commitAlias = () => {
    setRenaming(false);
    if (cancelAlias.current) {
      cancelAlias.current = false;
      setAliasDraft(savedAlias);
    } else if (!actionsDisabled && aliasDraft.trim() !== savedAlias) {
      void onSaveAlias(aliasDraft);
    }
  };
  // Two ways in, one state. The pencil is the direct one and sits on the name
  // itself; the Manage row is where someone who has never noticed a hover-only
  // control goes looking for what can be done to this entity.
  const beginRename = () => {
    cancelAlias.current = false;
    setAliasDraft(savedAlias);
    setRenaming(true);
  };

  // The standing rule for this exact app or domain, when there is one. It is
  // the panel's one real "current value", so the menu can show it instead of
  // forever offering to set something it may already have set.
  const exactRule = entity.exactRuleId !== null
    ? rules.find((rule) => rule.id === entity.exactRuleId) ?? null
    : null;
  const summary = entityClassification(entity);
  // Split by other rules, the exact rule is a default rather than the answer,
  // and the breakdown under the menu says so row by row.
  const overridden = exactRule !== null && entity.status === "mixed";
  const insightsLink = onViewInInsights && (
    <button
      type="button"
      onClick={onViewInInsights}
      className="flex shrink-0 cursor-pointer items-center gap-1 self-center rounded-sm text-xs text-accent underline-offset-2 outline-none hover:underline focus-visible:underline"
    >
      View insights
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h14m-7-7 7 7-7 7" />
      </svg>
    </button>
  );
  const order = WINDOW_ORDERS.find(
    (option) => option.sort === detailSort && option.direction === detailDirection,
  );
  // Title capture can be enabled between visits, so a range may contain both
  // titled and untitled windows.
  const untitled = groups.rows.length > 0 && groups.rows.every((group) => !group.title);
  const titlesReadable = hasStoredTitles && !untitled;
  // Only an entity that resolves to exactly one category has a baseline its
  // windows can be silent about.
  const baselineCategoryId = entity.status === "single"
    ? entity.categories[0]?.categoryId ?? null
    : null;
  const allWindowsSelected =
    groups.rows.length > 0 && groups.rows.every((group) => selectedWindowKeys.has(group.key));
  const selectedWindowCount = selectedWindowKeys.size;
  // Counted from the loaded rows, so it can only report windows still on
  // screen. A selection made before the filter narrowed is cleared with it, so
  // the two cannot disagree.
  const selectedVisitCount = groups.rows.reduce(
    (total, group) => total + (selectedWindowKeys.has(group.key) ? group.sessionCount : 0),
    0,
  );
  // An app with no category at all has a baseline too, just not a numbered
  // one: "Uncategorized" against each of its windows is the header's line
  // repeated, and only a window something did classify is worth naming.
  const rowCategory = (group: ActivityTitleGroup) => {
    const label = windowRowCategory(group, baselineCategoryId);
    return entity.status === "uncategorized" && label === "Uncategorized" ? null : label;
  };
  const previewSeconds = groups.rows.reduce((total, group) => total + group.seconds, 0);
  const appNames = appSuffixNames(entity.displayName, entity.key);

  return (
    <DetailPanel
      dock={dock}
      label={`Activity details: ${entity.displayName}`}
      eyebrow={
        <>
          <span>{entity.kind}</span>
          {entity.isNew && (
            <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
          )}
          {entity.noise && (
            <RowTag
              title={entity.noise === "utility"
                ? "Looks like an installer, driver, or local file — normally hidden from the list."
                : "Seen briefly and rarely across all history — normally hidden from the list."}
            >
              {entity.noise === "utility" ? "Utility" : "Rare"}
            </RowTag>
          )}
        </>
      }
      heading={renaming ? (
        <input
          autoFocus
          value={aliasDraft}
          placeholder={entity.displayName}
          disabled={actionsDisabled}
          aria-label={`Rename ${entity.displayName}`}
          onChange={(event) => setAliasDraft(event.target.value)}
          onBlur={commitAlias}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") {
              // Kept from the panel's own Escape, which would otherwise close
              // the thing being renamed rather than cancel the rename.
              event.stopPropagation();
              cancelAlias.current = true;
              event.currentTarget.blur();
            }
          }}
          className="mt-0.5 w-full rounded-md border border-control-edge bg-control px-2 py-0.5 text-lg font-semibold outline-none focus:border-accent/60"
        />
      ) : (
        // Keep rename beside the name it changes.
        <h2 className="group flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-lg font-semibold">{entity.displayName}</span>
          <button
            type="button"
            onClick={beginRename}
            disabled={actionsDisabled}
            title="Rename"
            aria-label={`Rename ${entity.displayName}`}
            className="shrink-0 rounded p-1 text-ink-3 opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </h2>
      )}
      // Keep the subtitle to the entity kind and identity.
      subtitle={
        <>
          {/* The key is already available from the source row's tooltip. */}
          <p className="copyable truncate font-mono text-xs text-ink-3">{entity.key}</p>
          {renaming && (
            <p className="mt-1 text-xs text-ink-3">Enter or click away to save. Leave blank to use the recorded name.</p>
          )}
        </>
      }
      onClose={onClose}
      closeLabel="Close activity details"
    >
      {/* First in the body: the panel's one standing decision. Not pinned in
          the header, which it made taller than the name it sits under. */}
      <PanelSection title="Classification" className="">
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="shrink-0">
            <MenuSelect
              align="start"
              // Show the exact rule's category as the current value; without
              // one, keep the menu as an action prompt.
              value={exactRule ? String(exactRule.categoryId) : ""}
              placeholder={entity.kind === "website" ? "Set website category…" : "Set app default…"}
              label={entity.kind === "website" ? "Set website category" : "Set app default"}
              // The assignment banner supplies scope at the moment it matters.
              onChange={(value) => void onAssign(Number(value))}
              disabled={actionsDisabled}
              options={categoryDestinationOptions(categories)}
            />
          </span>
          {/* What decided the value. With an exact rule the control already
              shows the category, so only the source is left to say. Wraps
              rather than truncating, and drops under the control when the panel
              is narrow: this is the line that says why, and cut short it said
              nothing. */}
          {/* Overridden, the list below names the default and every rule over
              it, so nothing is left to say here. Decided by its own App or
              Website rule alone, the detail is empty: the menu says it all. */}
          {!overridden && summary.detail && (
            <p className="min-w-[12rem] flex-1 text-xs leading-snug text-ink-3">
              <span>
                {exactRule ? summary.detail : `${summary.label} · ${summary.detail}`}
              </span>
            </p>
          )}
        </div>
        <ClassificationBreakdown entity={entity} />
      </PanelSection>

      {/* The strip is a glance at what Insights draws in full, so the way
          there reads as its "more". A single day draws no strip, and the link
          keeps the strip's place on its own. */}
      {usageStripPeak(usage) !== null ? (
        <UsageStrip buckets={usage} right={insightsLink} seconds={entity.seconds} />
      ) : insightsLink && (
        <div className="mt-8 flex justify-end">{insightsLink}</div>
      )}

      {/* Group visits by window title so this entity's history is readable. */}
      <section className="mt-8">
        {/* Expanded, the filter and order stay visible while the list scrolls.
            The preview has neither, so there is nothing to keep in view. */}
        <div className={windowsExpanded ? "sticky top-0 z-10 -mx-5 -mt-2 bg-surface px-5 pb-2.5 pt-2" : ""}>
          <div className="flex flex-wrap items-center gap-2">
            {/* Selection covers the loaded rows; pagination keeps the scope
                visible instead of selecting unseen windows. */}
            {windowsExpanded && titlesReadable && groups.rows.length > 0 && (
              <Checkbox
                checked={allWindowsSelected}
                indeterminate={selectedWindowCount > 0}
                onChange={actionsDisabled ? () => undefined : () => onToggleWindows(groups.rows)}
                label={allWindowsSelected
                  ? "Clear the window selection"
                  : `Select all ${countNoun(groups.rows.length, "window")}`}
                className={actionsDisabled ? "pointer-events-none opacity-50" : ""}
              />
            )}
            <h3 className="text-sm font-semibold">Windows</h3>
            {/* Keep the total and selected counts adjacent to the heading. */}
            <span className="min-w-0 truncate text-xs tabular-nums text-ink-3">
              {selectedWindowCount > 0
                ? `${countNoun(selectedVisitCount, "visit")} selected`
                // Untitled visits group into one blank "window", which is not
                // a window anyone had open.
                : !titlesReadable
                  ? countNoun(groups.sessionTotal, "visit")
                  : groups.sessionTotal > groups.total
                  ? `${countNoun(groups.sessionTotal, "visit")} in ${countNoun(groups.total, "window")}`
                  : countNoun(groups.total, "window")}
            </span>
            {windowsExpanded && (
              <button
                type="button"
                onClick={onCollapseWindows}
                className="ml-auto shrink-0 rounded-sm text-xs text-ink-3 underline-offset-2 outline-none hover:text-ink-2 hover:underline focus-visible:text-ink-2 focus-visible:underline"
              >
                Show fewer
              </button>
            )}
          </div>
          {/* Show either list controls or batch actions; filtering clears the
              current selection. */}
          {windowsExpanded && titlesReadable && (selectedWindowCount > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button variant="text-danger" disabled={actionsDisabled} onClick={onDeleteWindows}>Delete selected</Button>
              <MenuSelect
                variant="text-action"
                size="control"
                value=""
                placeholder={`Classify ${countNoun(selectedWindowCount, "window")}…`}
                label={`Classify every visit in the ${countNoun(selectedWindowCount, "selected window")}`}
                disabled={actionsDisabled}
                onChange={(value) =>
                  onClassifyWindows(value === AUTOMATIC_CLASSIFICATION ? null : Number(value))}
                options={[
                  { value: AUTOMATIC_CLASSIFICATION, label: "Use automatic classification" },
                  ...categoryDestinationOptions(categories, null, { dividerOffset: 1 })
                    .map((option, i) => (i === 0 ? { ...option, divider: true } : option)),
                ]}
              />
            </div>
          ) : (
            <div className="mt-2.5 flex items-center gap-2">
              <ClearableInput
                value={detailSearch}
                onChange={onDetailSearch}
                label="Filter windows"
                placeholder="Filter windows…"
                className="min-w-0 flex-1"
              />
              {groups.total > 1 && (
                <span className="shrink-0">
                  <MenuSelect
                    size="field"
                    variant="quiet"
                    align="end"
                    label="Order windows by"
                    value={order?.value ?? "seconds:desc"}
                    onChange={(value) => {
                      const picked = WINDOW_ORDERS.find((option) => option.value === value);
                      if (picked) onDetailSort(picked.sort, picked.direction);
                    }}
                    options={WINDOW_ORDERS.map(({ value, label }) => ({ value, label }))}
                  />
                </span>
              )}
            </div>
          ))}
        </div>
        {!titlesReadable ? (
          // Without stored titles there is no meaningful window breakdown. The
          // two cases are the ones Insights' window card tells apart: a setting
          // to change, or a setting already changed that only applies from now.
          <div className="mt-2 rounded-lg border border-edge/60 bg-surface-2/30 px-3 py-4 text-xs leading-snug text-ink-3">
            {titlesStored ? (
              <p>
                No window titles were recorded for this {kindLabel}, so its{" "}
                {countNoun(groups.sessionTotal, "visit")} cannot be broken down. Titles are stored
                for what is recorded from now on.
              </p>
            ) : (
              <>
                <p>
                  With window titles stored, this list shows what the time in this {kindLabel} was
                  spent on: documents, pages, conversations. Titles stay on this computer, and only
                  what is recorded after turning them on is broken down.
                </p>
                {onStoreTitles && (
                  <button
                    type="button"
                    onClick={onStoreTitles}
                    className="mt-2.5 text-accent underline-offset-4 outline-none transition-colors hover:underline hover:decoration-accent/50 focus-visible:underline"
                  >
                    Store window titles
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <div className={`flex flex-col ${windowsExpanded ? "" : "mt-2"}`}>
              {groups.rows.map((group) => (
                <PanelWindowRow
                  key={group.key}
                  group={group}
                  appNames={appNames}
                  search={detailSearch}
                  maxSeconds={groups.maxSeconds}
                  totalSeconds={entity.seconds}
                  category={rowCategory(group)}
                  selectable={windowsExpanded}
                  selectionActive={selectedWindowCount > 0}
                  selected={selectedWindowKeys.has(group.key)}
                  actionsDisabled={actionsDisabled}
                  onToggle={onToggleWindow}
                  onOpen={onOpenWindow}
                />
              ))}
              {groups.rows.length === 0 && (
                <p className="py-5 text-center text-xs text-ink-3">No windows match this filter.</p>
              )}
            </div>
            {groups.rows.length < groups.total && (windowsExpanded ? (
              <LoadMore shown={groups.rows.length} total={groups.total} onClick={onLoadMore} />
            ) : (
              // The share is the point of the line: it says whether the few
              // rows above are the whole story or the start of a long tail.
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-edge/50 px-1.5 pt-2.5 text-xs text-ink-3">
                <span className="tabular-nums">
                  Top {groups.rows.length} · {formatSharePercent(previewSeconds, entity.seconds)} of the time
                </span>
                <button
                  type="button"
                  onClick={onExpandWindows}
                  className="shrink-0 rounded-sm text-accent underline-offset-2 outline-none hover:underline focus-visible:underline"
                >
                  Show all {groups.total} windows
                </button>
              </div>
            ))}
          </>
        )}
      </section>

      {/* Keep curation actions together at the end of the panel. */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center gap-2">
          {/* The panel's section-title style, as Classification and Timeline
              take. In gray at 13px it matched the text actions beside it
              exactly and read as a fourth button. */}
          <h3 className="mr-auto text-sm font-semibold">Manage this {kindLabel}</h3>
          {/* Keep the actions together when the panel narrows. Text actions,
              as Settings' are: three bordered boxes here outweighed every
              heading in the panel. The hover boxes touch, so no gap, and the
              negative margin sets the last word on the panel's edge. */}
          <span className="-mr-3 flex items-center">
            {/* Actions read left to right as rename, stop recording, delete.
                Delete is red at rest, the rule Settings uses for every action
                that removes recorded history. */}
            <Button
              onClick={beginRename}
              disabled={actionsDisabled}
              title={`Change how this ${kindLabel} is labeled throughout Time. Recorded activity is untouched.`}
            >
              Rename
            </Button>
            <Button
              onClick={onExclude}
              disabled={actionsDisabled}
              title={`Never record this ${kindLabel} again. Existing history is kept.`}
            >
              Do not track
            </Button>
            <Button
              variant="text-danger-hover"
              onClick={onDeleteEntity}
              disabled={actionsDisabled}
              title="Removes recorded visits. Categories, rules, and aliases are kept."
            >
              Delete activity
            </Button>
          </span>
        </div>
      </section>
    </DetailPanel>
  );
}

