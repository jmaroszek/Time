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
  FloatingTooltip,
  MenuSelect,
  RemoveButton,
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
  countNoun,
  entityClassification,
  formatSharePercent,
  formatDateTime,
  formatLastSeen,
  formatShortDate,
  formatVisitDay,
  groupVisitsByDay,
  visitEditLabel,
  windowGroupClassification,
  windowRowCategory,
} from "../../lib/activityFormat";
import { type Category, type Rule } from "../../lib/classify";
import { uncategorizedMark } from "../../lib/chartTheme";
import { fmtDuration } from "../../lib/format";
import { useMeta } from "../../state/meta";
import { LoadMore } from "./ActivityFeedback";
import Chevron from "./Chevron";
import ClearableInput from "./ClearableInput";
import MatchedTitle from "./MatchedTitle";
import ShareBar from "./ShareBar";
import { RowTag } from "./ActivityTables";
import { categoryDestinationOptions } from "./menuOptions";
import { AUTOMATIC_CLASSIFICATION, RULE_LABELS } from "./ruleComposer";

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
  return (
    <div className="flex flex-col gap-1">
      {/* The date is shown once per day; each visit row carries its time. */}
      {groupVisitsByDay(group.sessions).map((day) => {
        const dayIds = day.visits.map((visit) => visit.id);
        const wholeDay = dayIds.every((id) => selected.has(id));
        return (
        <div key={day.key} className="mt-4 flex flex-col gap-1 first:mt-0">
          {/* This checkbox covers only the visits loaded for this day. */}
          <Checkbox
            checked={wholeDay}
            indeterminate={dayIds.some((id) => selected.has(id))}
            onChange={actionsDisabled ? () => undefined : () => onToggleMany(dayIds)}
            label={`Select the ${countNoun(dayIds.length, "visit")} shown on ${formatVisitDay(day.visits[0].start)}`}
            className={`text-micro uppercase tracking-[.04em] text-ink-3 ${actionsDisabled ? "pointer-events-none opacity-50" : ""}`}
          >
            {formatVisitDay(day.visits[0].start)}
          </Checkbox>
          {day.visits.map((session) => {
            const edited = visitEditLabel(session);
            return (
            <div key={session.id} className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={selected.has(session.id)}
                onChange={actionsDisabled ? () => undefined : () => onToggle(session.id)}
                label={`Select the visit starting ${formatDateTime(session.start)}`}
                className={actionsDisabled ? "pointer-events-none opacity-50" : ""}
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
                <button
                  type="button"
                  onClick={() => onEdit(session.id)}
                  disabled={actionsDisabled}
                  className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Edit
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
          : "h-full w-full flex-1"
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
          band above it — exactly 20px of it — through which the rows below
          scrolled in full view. Horizontal padding is unaffected and stays
          here, where the sticky headings' -mx-5 bleed still relies on it. */}
      <div className="scroll-well min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-5">
        <div className="pt-5">{children}</div>
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
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // 13px, not 12: these are the panel's top-level markers and sit a step
    // under the card titles' 14px rather than level with body copy. The gap
    // grew with them, or the sections read as one run of text.
    <section className={`mt-6 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-row font-semibold">{title}</h3>
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
 * The border, hover and focus ring therefore belong to the wrapper, so the row
 * still lights as one object whichever half the pointer is over.
 */
function PanelWindowRow({
  group,
  search,
  maxSeconds,
  totalSeconds,
  category,
  selected,
  actionsDisabled,
  onToggle,
  onOpen,
}: {
  group: ActivityTitleGroup;
  search: string;
  maxSeconds: number;
  totalSeconds: number;
  /** Null when it matches the app's own, and so is not worth the words. */
  category: string | null;
  selected: boolean;
  actionsDisabled: boolean;
  onToggle: (group: ActivityTitleGroup) => void;
  onOpen: (group: ActivityTitleGroup) => void;
}) {
  return (
    <div
      // The tint the catalog table already uses for a selected row, and only
      // that: the tick states the selection, so a second accent on the border
      // says it twice — and with every row selected the panel read as one
      // continuous glow rather than a list.
      className={`flex items-start gap-2 rounded-lg border border-edge/60 px-2.5 py-2 transition-colors focus-within:border-accent/60 ${
        selected ? "bg-accent/[.09]" : "hover:border-edge-2 hover:bg-hover"
      }`}
    >
      {/* Nudged onto the title's line rather than the row's top edge: the row
          is three lines tall and a box aligned to the block reads as belonging
          to the bar beneath the title as much as to the title itself. */}
      <Checkbox
        checked={selected}
        onChange={actionsDisabled ? () => undefined : () => onToggle(group)}
        label={`Select every visit to ${group.title || "this untitled window"}`}
        className={`mt-[3px] shrink-0 ${actionsDisabled ? "pointer-events-none opacity-50" : ""}`}
      />
    <button
      type="button"
      onClick={() => onOpen(group)}
      className="min-w-0 flex-1 text-left text-xs outline-none"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-ink-2">
          {/* Title capture can be switched on part way through a history, so
              one app can hold both kinds of row. A bare em dash left the
              untitled one looking like a rendering fault rather than a fact. */}
          {group.title
            ? <MatchedTitle title={group.title} search={search} />
            : <span className="italic text-ink-3">No title recorded</span>}
        </span>
        {group.isNew && (
          <RowTag tone="accent" title="First seen in all of your history inside this date range.">New</RowTag>
        )}
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
      <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-ink-3">
        <span className="tabular-nums">{fmtDuration(group.seconds)}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{countNoun(group.sessionCount, "visit")}</span>
        {category !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">{category}</span>
          </>
        )}
        <span className="ml-auto shrink-0 tabular-nums">{formatLastSeen(group.lastSeen)}</span>
      </span>
    </button>
    </div>
  );
}

export function WindowPanel({
  dock,
  group,
  usage,
  rangeDays,
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
  /** Calendar days the range spans, so "days seen" has a denominator. */
  rangeDays: number;
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
  const classification = windowGroupClassification(group);
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
        <h2 className="break-words text-lg font-semibold">
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
          {" · "}{group.entityKind === "website" ? "Website" : "App"} · <span className="font-mono">{group.entityKey}</span>
        </p>
      }
      onBack={onBack}
      backLabel={`Back to ${group.displayName} details`}
      onClose={onClose}
      closeLabel="Close Window details"
    >
      <DetailMetricGrid>
        <DetailMetric
          label="Time in range"
          value={fmtDuration(group.seconds)}
          hint={`Every visit to this window across the ${countNoun(rangeDays, "day")} shown, added up.`}
        />
        <DetailMetric
          label="Average visit"
          value={group.sessionCount > 0
            ? fmtDuration(group.seconds / group.sessionCount)
            : "—"}
          hint={`Time in range divided by its ${countNoun(group.sessionCount, "visit")}.`}
        />
        <DetailMetric
          label="Days seen"
          value={String(group.daysSeen)}
          hint={`Out of ${countNoun(rangeDays, "day")} in this range.`}
        />
        <DetailMetric label="Last seen" value={formatLastSeen(group.lastSeen)} />
      </DetailMetricGrid>

      <UsageStrip buckets={usage} />

      <PanelSection
        title="Classification"
        right={<span className="shrink-0"><Button disabled={actionsDisabled} onClick={() => onMakeRule(group)}>Create Window rule</Button></span>}
      >
        {/* Keep both the category and its source visible in this panel. */}
        <p className="mt-2 text-xs text-ink-2">{classification.label}</p>
        <p className="mt-0.5 text-xs leading-snug text-ink-3">{classification.detail}</p>
      </PanelSection>
      <section className="mt-6">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-row font-semibold">Visits</h3>
          {/* Keep the reversible selection control at the right edge; batch
              actions appear before it when a selection exists. */}
          {selectedSessionIds.size > 0 && (
            <>
              <Button variant="danger" disabled={actionsDisabled} onClick={onDeleteSelected}>Delete selected</Button>
              {/* This action writes an override on each selected visit, not a
                  standing rule. */}
              <MenuSelect
                variant="action"
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
          <Button disabled={actionsDisabled} onClick={() => onToggleAllSessions(group.sessionIds)}>
            {allSelected ? "Clear selection" : `Select all ${group.sessionCount} visits`}
          </Button>
        </div>
        <div className="mt-3 rounded-lg border border-edge/60 bg-surface-2/30 px-3 py-2.5">
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
 * How an entity's time divides, drawn as well as listed.
 *
 * Category colors distinguish the proportions represented by each slice.
 */
function CategorySplit({ entity }: { entity: ActivityEntitySummary }) {
  const { theme } = useMeta();
  const slices = [
    ...entity.categories.map((category) => ({
      key: `category:${category.categoryId}`,
      name: category.name,
      color: category.color,
      seconds: category.seconds,
    })),
    ...(entity.uncategorizedSeconds > 0
      ? [{
          key: "uncategorized",
          name: "Uncategorized",
          color: uncategorizedMark(theme),
          seconds: entity.uncategorizedSeconds,
        }]
      : []),
  ];
  const total = slices.reduce((sum, slice) => sum + slice.seconds, 0);
  // One slice is not a division. Drawing a full-width bar and a row reading
  // "100%" only restates the label directly above it.
  if (total <= 0 || slices.length < 2) return null;
  const share = (seconds: number) => {
    const percent = (seconds / total) * 100;
    return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  };
  return (
    <>
      <span aria-hidden="true" className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        {slices.map((slice) => (
          <span
            key={slice.key}
            style={{ width: `${(slice.seconds / total) * 100}%`, backgroundColor: slice.color }}
          />
        ))}
      </span>
      <div className="mt-3 flex flex-col gap-2">
        {slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-2 text-xs">
            <CategoryDot color={slice.color} />
            <span className="min-w-0 flex-1 truncate">{slice.name}</span>
            <span className="tabular-nums text-ink-3">{fmtDuration(slice.seconds)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-3">{share(slice.seconds)}</span>
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
function UsageStrip({ buckets }: { buckets: ActivityDayBucket[] }) {
  const peak = buckets.reduce((most, bucket) => Math.max(most, bucket.seconds), 0);
  if (buckets.length < 2 || peak <= 0) return null;
  const spanLabel = (bucket: ActivityDayBucket) => (bucket.days === 1
    ? formatShortDate(bucket.startSec)
    : `${formatShortDate(bucket.startSec)} – ${formatShortDate(bucket.endSec - 1)}`);
  return (
    <section className="mt-6">
      {/* The same word Insights gives the same idea. A section heading naming
          its own chart beats one phrased as the question the chart answers. */}
      <h3 className="text-row font-semibold">Timeline</h3>
      <div className="mt-2.5 flex h-10 items-end gap-px border-b border-edge/70">
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
        <span>{formatShortDate(buckets[0].startSec)}</span>
        <span>{fmtDuration(peak)} on the busiest {buckets[0].days === 1 ? "day" : "column"}</span>
        <span>{formatShortDate(buckets[buckets.length - 1].endSec - 1)}</span>
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
  rangeSeconds,
  rangeDays,
  hasStoredTitles,
  detailSearch,
  onDetailSearch,
  detailSort,
  detailDirection,
  onDetailSort,
  onLoadMore,
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
  onRemoveExactRule,
  actionsDisabled = false,
}: {
  dock: CSSProperties | null;
  entity: ActivityEntitySummary;
  groups: ActivityTitleGroupPage;
  usage: ActivityDayBucket[];
  /** All recorded time in the range, for the share this entity holds of it. */
  rangeSeconds: number;
  /** Calendar days the range spans, so "days seen" has a denominator. */
  rangeDays: number;
  hasStoredTitles: boolean;
  detailSearch: string;
  onDetailSearch: (value: string) => void;
  detailSort: ActivityWindowSort;
  detailDirection: ActivitySortDirection;
  onDetailSort: (sort: ActivityWindowSort, direction: ActivitySortDirection) => void;
  onLoadMore: () => void;
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
  onRemoveExactRule: () => Promise<void>;
  /** The result is stale while a replacement worker query is in flight. */
  actionsDisabled?: boolean;
}) {
  const kindLabel = entity.kind === "website" ? "website" : "app";
  const savedAlias = aliases[entity.key.toLowerCase()] ?? "";
  const [aliasDraft, setAliasDraft] = useState(savedAlias);
  const [renaming, setRenaming] = useState(false);
  const [confirmingRuleRemoval, setConfirmingRuleRemoval] = useState(false);
  const cancelAlias = useRef(false);
  useEffect(() => setAliasDraft(savedAlias), [savedAlias, entity.key]);
  // Both are about the entity in front of the reader, and the arrow keys can
  // change that without anything being clicked.
  useEffect(() => {
    setRenaming(false);
    setConfirmingRuleRemoval(false);
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
          <p className="truncate font-mono text-xs text-ink-3">{entity.key}</p>
          {renaming && (
            <p className="mt-1 text-xs text-ink-3">Enter or click away to save. Leave blank to use the recorded name.</p>
          )}
        </>
      }
      onClose={onClose}
      closeLabel="Close activity details"
    >
      <DetailMetricGrid>
        {/* Each hint carries the fact its tile could not fit — a share, a
            denominator, the arithmetic behind a derived number — and stops
            there. No restating the label, and no sentence explaining how to
            feel about the figure. */}
        <DetailMetric
          label="Time in range"
          value={fmtDuration(entity.seconds)}
          hint={rangeSeconds > 0
            ? `${formatSharePercent(entity.seconds, rangeSeconds)} of everything recorded across the ${countNoun(rangeDays, "day")} shown.`
            : `Measured across the ${countNoun(rangeDays, "day")} shown.`}
        />
        {/* Average visit gives the count a time scale; the denominator remains
            in the hint. */}
        <DetailMetric
          label="Average visit"
          value={entity.sessionCount > 0
            ? fmtDuration(entity.seconds / entity.sessionCount)
            : "—"}
          hint={`Time in range divided by its ${countNoun(entity.sessionCount, "visit")}.`}
        />
        <DetailMetric
          label="Days seen"
          value={String(entity.daysSeen)}
          hint={`Out of ${countNoun(rangeDays, "day")} in this range.`}
        />
        {/* Last seen is self-explanatory, so it needs no secondary hint. */}
        <DetailMetric label="Last seen" value={formatLastSeen(entity.lastSeen)} />
      </DetailMetricGrid>

      <UsageStrip buckets={usage} />

      <PanelSection title="Classification">
        {/* An exact rule supplies the current value; its source stays beside the
            control. Other states show the explanatory line below. */}
        <div className="mt-2 flex items-center justify-between gap-3">
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
          {/* With an exact rule, this line explains what decided the value. */}
          {exactRule && (
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="min-w-0 truncate text-xs leading-snug text-ink-2">{summary.detail}</p>
              {/* Keep rule removal compact beside the rule it removes. */}
              {!confirmingRuleRemoval && (
                // Align the compact glyph with the rule text.
                <span className="flex translate-y-px">
                  <RemoveButton
                    compact
                    label={`Remove the ${entity.kind === "website" ? "Website" : "App"} rule for ${entity.key}`}
                    onClick={actionsDisabled ? () => undefined : () => setConfirmingRuleRemoval(true)}
                  />
                </span>
              )}
            </div>
          )}
        </div>
        {/* Without an exact rule, show the category and its source below the
            action control. */}
        {!exactRule && (
          <>
            <p className="mt-3.5 text-xs text-ink-2">{summary.label}</p>
            <p className="mt-0.5 text-xs leading-snug text-ink-3">{summary.detail}</p>
          </>
        )}
        {entity.status === "mixed" && (
          <p className="mt-2 text-xs text-ink-3">Website and Window rules can override an App default.</p>
        )}
        <CategorySplit entity={entity} />
        {/* Only when there is something to compare. A single rule is already
            named in the line above, and repeating it in a bordered box read as
            two different facts about the same thing. */}
        {entity.rules.length > 1 && (
          <div className="mt-4 rounded-lg border border-edge/70 bg-surface-2 px-3 py-2.5">
            <p className="mb-2 text-xs font-medium text-ink-2">Rules in use</p>
            <div className="flex flex-col gap-2">
              {entity.rules.map((rule) => (
                <div key={rule.ruleId} className="flex items-center gap-2 text-xs">
                  <span className="w-14 shrink-0 text-ink-3">{RULE_LABELS[rule.matchType]}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={rule.pattern}>{rule.pattern}</span>
                  <CategoryDot color={rule.categoryColor} />
                  <span className="truncate text-ink-2">{rule.categoryName}</span>
                  <span className="shrink-0 tabular-nums text-ink-3">{rule.sessions} · {fmtDuration(rule.seconds)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {exactRule && confirmingRuleRemoval && (
          // Confirm removal because existing activity may become uncategorized.
          <div className="mt-3 rounded-lg border border-bad/25 bg-bad/[.035] px-3 py-2.5 text-xs leading-snug text-ink-2">
            <p>
              Remove the {entity.kind === "website" ? "Website" : "App"} rule
              {" "}<span className="font-mono">{exactRule.pattern}</span>? Time it decided becomes
              uncategorized unless another rule matches. Manual corrections are kept.
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button onClick={() => setConfirmingRuleRemoval(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={actionsDisabled}
                onClick={() => { setConfirmingRuleRemoval(false); void onRemoveExactRule(); }}
              >
                Remove rule
              </Button>
            </div>
          </div>
        )}
      </PanelSection>

      {/* Group visits by window title so this entity's history is readable. */}
      <section className="mt-6">
        {/* Keep filtering and ordering visible while the window list scrolls. */}
        <div className="sticky top-0 z-10 -mx-5 -mt-2 bg-surface px-5 pb-2.5 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Selection covers the loaded rows; pagination keeps the scope
                visible instead of selecting unseen windows. */}
            {titlesReadable && groups.rows.length > 0 && (
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
            <h3 className="text-row font-semibold">Windows</h3>
            {/* Keep the total and selected counts adjacent to the heading. */}
            <span className="min-w-0 truncate text-xs tabular-nums text-ink-3">
              {selectedWindowCount > 0
                ? `${countNoun(selectedVisitCount, "visit")} selected`
                : groups.sessionTotal > groups.total
                  ? `${countNoun(groups.sessionTotal, "visit")} in ${countNoun(groups.total, "window")}`
                  : countNoun(groups.total, "window")}
            </span>
          </div>
          {/* Show either list controls or batch actions; filtering clears the
              current selection. */}
          {titlesReadable && (selectedWindowCount > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button variant="danger" disabled={actionsDisabled} onClick={onDeleteWindows}>Delete selected</Button>
              <MenuSelect
                variant="action"
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
          // Without stored titles there is no meaningful window breakdown.
          <p className="rounded-lg border border-edge/60 bg-surface-2/30 px-3 py-4 text-xs leading-snug text-ink-3">
            No window titles were recorded for this {kindLabel}, so its{" "}
            {countNoun(groups.sessionTotal, "visit")} cannot be broken down. Title capture is off by
            default; Settings can turn it on for what is recorded from now on.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {groups.rows.map((group) => (
                <PanelWindowRow
                  key={group.key}
                  group={group}
                  search={detailSearch}
                  maxSeconds={groups.maxSeconds}
                  totalSeconds={entity.seconds}
                  category={windowRowCategory(group, baselineCategoryId)}
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
            {groups.rows.length < groups.total && (
              <LoadMore shown={groups.rows.length} total={groups.total} onClick={onLoadMore} />
            )}
          </>
        )}
      </section>

      {/* Keep curation actions together at the end of the panel. */}
      <section className="mt-7 border-t border-edge/60 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-row font-semibold text-ink-2">Manage this {kindLabel}</h3>
          {/* Keep the actions together when the panel narrows. */}
          <span className="flex items-center gap-2">
            {/* Actions read left to right as rename, stop recording, delete. */}
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
              variant="quiet-danger"
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

/**
 * The four summary tiles at the top of a detail panel.
 *
 * Two across or four, decided by the panel's own width rather than the window's
 * — the panel is the one surface here whose width runs *against* the viewport's.
 * Below WIDE_DETAIL_MIN it is the card's drill-in face and grows with the page;
 * at and above it the panel shrinks into the right margin and caps at
 * PANEL_MAX_WIDTH. A media query would therefore flip these to a row of four at
 * exactly the width where they stop fitting, so the breakpoint is a container
 * query on the block itself.
 *
 * 45rem is where a quarter of the block reaches 171px, which is the width the
 * Insights tiles have at the `md:` breakpoint that turns *them* into a row. The
 * two sets are the same tiles, so they earn four across at the same size rather
 * than at the same window width — and at 171px the widest value any of these
 * carries, an all-two-digit "Today, 12:34 PM" last-seen at 115px, has 30px of
 * air. That margin is the whole reason the threshold is not lower: truncating
 * the last-seen tile is what kept this block at two across to begin with.
 *
 * The docked panel's content box tops out near 36rem, so the outboard layout
 * never reaches the threshold and stays 2x2 — which is correct for it.
 */
function DetailMetricGrid({ children }: { children: ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-3 @[45rem]:grid-cols-4">{children}</div>
    </div>
  );
}

function DetailMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** Explains the measure on hover or focus, the way the Insights tiles do.
   *  Anything that would otherwise become a second line under the value
   *  belongs here — four tiles in a grid only read as a set while they are
   *  the same height. */
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-edge bg-surface-2 p-3">
      {/* -raised, not plain ink-3: the tile's fill is above the page, and ink-3
          is pinned to the page. See the token pair in index.css. */}
      <p className="text-xs text-ink-3-raised">
        {hint ? (
          // The label joins the *accessible* name only. A screen reader has no
          // layout telling it the tooltip belongs to the label above it, so it
          // needs both; the visible tooltip already sits under that label and
          // printing it again there was restating the tile to its own reader.
          <FloatingTooltip
            text={hint}
            ariaLabel={`${label}. ${hint}`}
            className="cursor-help outline-none"
          >
            {label}
          </FloatingTooltip>
        ) : label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums" title={value}>{value}</p>
    </div>
  );
}
