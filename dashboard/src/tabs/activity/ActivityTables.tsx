import { type ReactNode } from "react";

import { MenuSelect, type MenuOption } from "../../components/ui";
import {
  BACKLOG_BADGE_SECONDS,
  type ActivityEntityPage,
  type ActivityEntitySummary,
  type ActivityQueryResult,
  type ActivitySort,
  type ActivitySortDirection,
  type ActivityTitleGroup,
  type ActivityTitleGroupPage,
  type ActivityTriage,
  type ActivityTriageItem,
  type ActivityTypeFilter,
  type ActivityWindowSort,
} from "../../lib/activity";
import {
  countNoun,
  entityRowDomId,
  formatLastSeen,
  windowGroupClassification,
} from "../../lib/activityFormat";
import { type Category } from "../../lib/classify";
import { fmtDuration } from "../../lib/format";
import {
  activityRowAccessibleLabel,
  activitySummaryColumns,
  useViewportWidth,
} from "../../lib/responsive";
import { type StarterSuggestion } from "../../lib/starterSuggestions";
import { LoadMore, NoResults } from "./ActivityFeedback";
import ClearableInput from "./ClearableInput";
import MatchedTitle from "./MatchedTitle";
import ShareBar from "./ShareBar";
import { triageCategoryOptions } from "./menuOptions";

export type ActivityView = "library" | "rules";

/** Excluded is a curation view, not a property of an already-recorded entity. */
export type LibraryFilter = import("../../lib/activity").ActivityClassificationFilter | "excluded";

export type ClassifiableEntity = Pick<ActivityEntitySummary, "kind" | "key" | "displayName">;

export function ViewSwitcher({ view, onView }: { view: ActivityView; onView: (view: ActivityView) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-2.5">
      {/* Named for what it lists, not for what it is. "Library" promised an
          archive, which made the Unclassified queue above the table read as
          somebody else's business; against "Categories & Rules" it also states
          the split the two faces actually make — the things on one side, the
          labels on the other. */}
      <ViewButton active={view === "library"} onClick={() => onView("library")}>Apps &amp; Websites</ViewButton>
      <span aria-hidden="true" className="text-edge-2">|</span>
      <ViewButton active={view === "rules"} onClick={() => onView("rules")}>Categories &amp; Rules</ViewButton>
    </span>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`transition-colors ${active ? "text-ink" : "font-normal text-ink-3 hover:text-ink-2"}`}
    >
      {children}
    </button>
  );
}

/**
 * One bounded well for whatever the Library is showing. Without the bound the
 * card stretches the page every time "load more" is pressed; with it, the
 * footprint is stable and only the well gets deeper.
 *
 * The bound is the leftover viewport height rather than a fraction of it: the
 * well does not start at the top of the screen, so any fixed vh can only be
 * right at one window size — it left a tall monitor with several rows of dead
 * space below the card and squeezed a short one.
 */
export function TableRegion({ children }: { children: ReactNode }) {
  // pr-4 is the scrollbar's gutter: the last column is right-aligned, so
  // without it the dates sit against the scrollbar.
  return (
    <div className="scroll-well min-h-0 flex-1 overflow-auto pr-1 sm:min-h-[240px] sm:pr-4">{children}</div>
  );
}

/**
 * Three kinds of filter share one menu, and the rules mark the seams: how an
 * entity is classified, which category it landed in, and last the two ways an
 * entity sits outside the count — ignored, which is recorded but excluded from
 * Insights, and excluded, which is never recorded at all. The category rule
 * moves to whichever category comes first and disappears with them when none
 * are defined.
 */
function classificationOptions(categories: Category[], uncategorizedCount: number): MenuOption[] {
  const named = categories.filter((category) => !category.isIgnored);
  return [
    { value: "all", label: "All classifications" },
    // The count rides the option that applies the filter rather than sitting
    // in the card header as a second entry point to it: one control, and one
    // that can show whether it is engaged.
    {
      value: "uncategorized",
      label: uncategorizedCount > 0 ? `Uncategorized (${uncategorizedCount})` : "Uncategorized",
    },
    { value: "mixed", label: "Mixed" },
    ...named.map((category, i) => ({
      value: `category:${category.id}`,
      label: category.name,
      divider: i === 0,
    })),
    { value: "ignored", label: "Ignored", divider: true },
    { value: "excluded", label: "Excluded from tracking" },
  ];
}

/**
 * A text filter that can be emptied without selecting its contents.
 *
 * Both of this tab's filters swap out the list beneath them, so both need a way
 * back that is not "select the text and delete it" — Escape, and a trailing ✕
 * for the mouse. They were not sharing one, and only the wider of the two had
 * either. The visible label is optional; the accessible one is not, because a
 * placeholder disappears the moment anything is typed into it.
 */
/**
 * Pending classification work, with the decision attached.
 *
 * The Library could already tell you an item was unclassified — on its own row,
 * in a word, sorted by time so the newest and smallest sat below the fold, and
 * counted only inside a dropdown nobody opens. What it could not do was let you
 * act: the category picker lives in the inspector, behind a click on the row
 * most people never make. This section exists for the action; the count is what
 * makes it worth looking at.
 *
 * It renders nothing when there is nothing pending, which is what keeps it a
 * state rather than furniture — and what lets it be this legible while it is up.
 */
export function UnclassifiedSection({
  triage,
  categories,
  suggestionByItemId,
  suggestionCount,
  onReview,
  onAssign,
  onShowAll,
}: {
  triage: ActivityTriage;
  categories: Category[];
  suggestionByItemId: Map<string, StarterSuggestion<ActivityTriageItem>>;
  suggestionCount: number;
  onReview: () => void;
  onAssign: (item: ActivityTriageItem, categoryId: number) => void;
  onShowAll: () => void;
}) {
  if (triage.total === 0) return null;
  const listed = triage.items.length;
  // The same floor the tab badge uses. Per-row suggestions need no gate — they
  // cost nothing and teach the mechanism — but an invitation to sit down and
  // review a list has to be worth the interruption first.
  const offerReview = suggestionCount > 0 && triage.seconds >= BACKLOG_BADGE_SECONDS;
  return (
    <section
      aria-labelledby="unclassified-heading"
      // Recessed rather than tinted: the accent wash the first-run panel and the
      // domain hint use is for news that arrives once. This comes back every
      // time something new is installed, and a recurring chore should not keep
      // making that loud a promise. The bottom margin is larger than the card's
      // usual rhythm on purpose — the controls below belong to the table, and at
      // an even gap the two surfaces read as one continuous thing.
      // Gone below sm, where this card stops promising a usable table well at
      // all — TableRegion drops its 240px floor at the same breakpoint, so the
      // five rows here would be spending a vertical budget that no longer
      // exists and the table underneath would collapse to nothing. The window
      // cannot actually be dragged this narrow (tauri.conf floors it at
      // 1000px); the rule is that going under it degrades the page rather than
      // crushing it, and the tab badge still says there is work waiting.
      className="mb-6 hidden shrink-0 rounded-[12px] border border-edge bg-surface-dim px-3.5 py-3 sm:block"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="unclassified-heading" className="text-row font-semibold text-ink">
          Unclassified
          {/* The scope, stated: everything else in this card reads the selected
              range, and a backlog that emptied when the date picker moved would
              be a to-do list nobody could finish. */}
          <span className="ml-2 text-meta font-normal text-ink-3">all history</span>
        </h3>
        <span className="text-xs tabular-nums text-ink-3">
          {`${triage.total} ${triage.total === 1 ? "item" : "items"} · ${fmtDuration(triage.seconds)}`}
          {triage.total > listed && (
            <>
              {" · "}
              <button
                type="button"
                onClick={onShowAll}
                className="tabular-nums underline-offset-2 hover:text-ink-2 hover:underline"
              >
                Show all
              </button>
            </>
          )}
        </span>
      </div>
      {/* Why this is worth a minute, in the one place someone is looking at the
          consequence. The Insights timeline draws this time in a near-surface
          gray that reads as "nothing here" rather than "not yet decided". */}
      <p className="mt-1 text-meta leading-snug text-ink-3">
        Time in these apps and sites is left out of every category total in Insights until you
        classify it.
      </p>
      {/* An offer, phrased as one. It names the source in the same breath so the
          reader knows a list shipped with Time is doing the recognizing, and
          nothing has been decided for them yet. */}
      {offerReview && (
        <p className="mt-2 text-meta leading-snug text-ink-2">
          {suggestionCount === 1
            ? "One of these matches Time's starter list of common apps."
            : `${suggestionCount} of these match Time's starter list of common apps.`}{" "}
          <button
            type="button"
            onClick={onReview}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Review
          </button>
        </p>
      )}
      <div className="mt-2">
        {triage.items.map((item) => (
          <TriageRow
            key={item.id}
            item={item}
            categories={categories}
            suggestion={suggestionByItemId.get(item.id) ?? null}
            onAssign={onAssign}
          />
        ))}
      </div>
    </section>
  );
}

/** One decision. Identity, kind, total, control — and nothing else: days seen
 *  and a share bar belong to a table you are reading, not to a row you are
 *  about to remove. The kind stays because it is not always "App" (a browser
 *  with no rule yet puts websites here) and because an app and a website can
 *  carry the same name, which on this row is the only thing telling them
 *  apart. */
function TriageRow({
  item,
  categories,
  suggestion,
  onAssign,
}: {
  item: ActivityTriageItem;
  categories: Category[];
  suggestion: StarterSuggestion<ActivityTriageItem> | null;
  onAssign: (item: ActivityTriageItem, categoryId: number) => void;
}) {
  const suggested = suggestion
    ? categories.find((category) => category.id === suggestion.categoryId) ?? null
    : null;
  return (
    <div className="flex items-center gap-3 rounded-lg border-t border-edge py-1.5 pr-1 pl-0.5 first:border-t-0 hover:bg-hover">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-row font-semibold text-ink">{item.displayName}</span>
        <span className="shrink-0 text-meta text-ink-3">
          {item.kind === "website" ? "Website" : "App"}
        </span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-ink-2">{fmtDuration(item.seconds)}</span>
      {/* Its own button rather than a pre-filled trigger below. The control
          beside it shows no value on purpose — see its note — and a suggestion
          rendered as the current selection would say this row is already
          Communication when it is still uncategorized. A separate button is the
          honest shape: one click accepts, and nothing claims to have happened
          until it is pressed. */}
      {suggested && (
        <button
          type="button"
          title={`${suggestion?.reason}. Classifies ${item.displayName} in all history.`}
          onClick={() => onAssign(item, suggested.id)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-edge-2 px-2 py-1 text-xs text-ink-2 transition-colors hover:border-accent/40 hover:text-ink"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: suggested.color }}
          />
          {suggested.name}
          <span className="text-micro text-ink-3">suggested</span>
        </button>
      )}
      {/* A placeholder trigger, not a value: every row here is uncategorized, so
          showing that as the current selection would print the same word five
          times and call it information. The verb is what the control does. */}
      <MenuSelect
        size="compact"
        variant="resting"
        align="end"
        label={`Classify ${item.displayName}`}
        placeholder={suggested ? "Other" : "Classify"}
        value=""
        onChange={(value) => onAssign(item, Number(value))}
        options={triageCategoryOptions(categories)}
      />
    </div>
  );
}

/**
 * Where a row can go. Not classificationOptions: that list is filters — it
 * opens with "All classifications" and folds every ignored category into one
 * synthetic "Ignored" entry, neither of which is somewhere an entity can be
 * put. This one is destinations, so the real ignored rows appear by name behind
 * a rule. Without them a row you will never classify has no way to leave, and a
 * to-do list with a permanent top item stops being read.
 */
export function LibraryControls({
  search,
  onSearch,
  typeFilter,
  onTypeFilter,
  classificationFilter,
  onClassificationFilter,
  categories,
  uncategorizedCount,
  noiseHidden,
  includeNoise,
  onIncludeNoise,
}: {
  search: string;
  onSearch: (value: string) => void;
  typeFilter: ActivityTypeFilter;
  onTypeFilter: (value: ActivityTypeFilter) => void;
  classificationFilter: LibraryFilter;
  onClassificationFilter: (value: LibraryFilter) => void;
  categories: Category[];
  uncategorizedCount: number;
  noiseHidden: number;
  includeNoise: boolean;
  onIncludeNoise: () => void;
}) {
  // Search and type narrow recorded activity; the excluded list is not
  // recorded activity, so leaving them enabled there would be a lie.
  const searching = classificationFilter !== "excluded";
  return (
    <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/50 pb-4">
      {searching ? (
        <>
          <ClearableInput
            value={search}
            onChange={onSearch}
            label="Search activity"
            placeholder="Search apps, websites, and windows…"
            leadingIcon
            className="min-w-0 basis-full sm:min-w-[240px] sm:max-w-[360px] sm:basis-auto sm:flex-1"
          />
          <MenuSelect
            size="field"
            variant={typeFilter === "all" ? "resting" : "engaged"}
            label="Activity type"
            className="min-w-0 flex-1 sm:flex-none"
            value={typeFilter}
            onChange={(value) => onTypeFilter(value as ActivityTypeFilter)}
            options={[
              { value: "all", label: "All types" },
              { value: "app", label: "Apps" },
              { value: "website", label: "Websites" },
            ]}
          />
        </>
      ) : (
        <span className="min-w-0 basis-full text-xs text-ink-3 sm:min-w-[240px] sm:basis-auto sm:flex-1">
          Apps and websites Time is not allowed to record.
        </span>
      )}
      <MenuSelect
        size="field"
        variant={classificationFilter === "all" ? "resting" : "engaged"}
        label="Classification filter"
        className="min-w-0 flex-1 sm:flex-none"
        value={classificationFilter}
        onChange={(value) => onClassificationFilter(value as LibraryFilter)}
        options={classificationOptions(categories, uncategorizedCount)}
      />
      {/* Muted, not accent: this is about rows nobody asked to see, and it was
          the loudest thing in the card header while being the least
          consequential. It sits with the filters because it is one — the row of
          controls that decides what the table lists. It is pushed to the far
          right (ml-auto) rather than following the dropdowns directly, so it
          reads as a status note beside the toolbar instead of one more control
          crowded into it. */}
      {noiseHidden > 0 && (
        <button
          type="button"
          onClick={onIncludeNoise}
          className="shrink-0 text-xs text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline sm:ml-auto"
          title="Rare-item and utility rows are hidden from this list. They still count in every total."
        >
          {includeNoise ? `Hide ${noiseHidden} filtered` : `${noiseHidden} filtered · Show`}
        </button>
      )}
    </div>
  );
}

/**
 * `offset` is for tables that sit under a sticky group heading: both stick to
 * the same scroll container, so the header row has to start where the heading
 * ends or it lands underneath it.
 */
function StickyHead({ children, offset = "top-0" }: { children: ReactNode; offset?: string }) {
  return (
    <thead className={`sticky z-10 bg-surface shadow-[0_1px_0_var(--color-edge)] ${offset}`}>
      {children}
    </thead>
  );
}

type SummaryTableSort = "label" | "seconds" | "days" | "lastSeen";

interface SummaryTableBadge {
  label: string;
  title: string;
  tone?: "muted" | "accent";
}

interface SummaryTableRow {
  key: string;
  /** DOM id, for callers that need to scroll a row into view from outside the
   *  table — the identity list does, once the arrow keys can move its
   *  selection while the reader's hands are nowhere near it. */
  anchorId?: string;
  primary: ReactNode;
  primaryLabel: string;
  primaryTitle?: string;
  metadata: ReactNode;
  badges: SummaryTableBadge[];
  seconds: number;
  daysSeen: number;
  lastSeen: number;
  selected: boolean;
  openLabel: string;
  onOpen: () => void;
}

function SummarySortHeading({
  label,
  field,
  active,
  direction,
  className = "",
  onSort,
}: {
  label: string;
  field: SummaryTableSort;
  active: boolean;
  direction: ActivitySortDirection;
  className?: string;
  onSort: (field: SummaryTableSort) => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : undefined}
      className={`pb-2 font-medium ${className}`}
    >
      <button type="button" onClick={() => onSort(field)} className="inline-flex items-center gap-1 hover:text-ink-2">
        {label}{active && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

/**
 * Both Activity summaries deliberately share this renderer. The columns are a
 * reading rhythm, not a property of either data source: identity or title,
 * relative time, exact time, recurrence, recency. Keeping their widths and
 * cell spacing here means the two tables line up exactly and cannot drift as
 * either row gains new metadata.
 */
function SummaryTable({
  rows,
  tableLabel,
  scale,
  sort,
  direction,
  onSort,
  headOffset,
}: {
  rows: SummaryTableRow[];
  tableLabel: string;
  scale: BarScale;
  sort: SummaryTableSort;
  direction: ActivitySortDirection;
  onSort: (field: SummaryTableSort) => void;
  headOffset?: string;
}) {
  const compactColumns = activitySummaryColumns(useViewportWidth()).length === 3;
  return (
    <table aria-label={tableLabel} className="w-full table-fixed text-xs">
      {/* Sticky via a shadow, not a border: a collapsed table's borders do not
          travel with a stuck header row. */}
      <StickyHead offset={headOffset}>
        <tr className="text-left text-xs text-ink-3">
          <SummarySortHeading
            label="Name"
            field="label"
            active={sort === "label"}
            direction={direction}
            onSort={onSort}
            className="w-[27%] text-left max-md:w-[52%]"
          />
          {/* The bar draws what Time already sorts, so it has no independent
              heading or sort state. */}
          {!compactColumns && (
            <th scope="col" className="w-[37%] pb-2">
              <span className="sr-only">Time relative to the busiest result</span>
            </th>
          )}
          <SummarySortHeading
            label="Time"
            field="seconds"
            active={sort === "seconds"}
            direction={direction}
            onSort={onSort}
            className="w-[9%] text-right max-md:w-[20%]"
          />
          {/* Centering keeps a one- or two-digit count from clinging to either
              adjacent measure. The offset balances Last seen's right edge. */}
          {!compactColumns && (
            <SummarySortHeading
              label="Days seen"
              field="days"
              active={sort === "days"}
              direction={direction}
              onSort={onSort}
              className="w-[15%] pl-8 text-center"
            />
          )}
          <SummarySortHeading
            label="Last seen"
            field="lastSeen"
            active={sort === "lastSeen"}
            direction={direction}
            onSort={onSort}
            className="w-[12%] text-right max-md:w-[28%]"
          />
        </tr>
      </StickyHead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            id={row.anchorId}
            // The panel no longer covers the list, so the open row is on screen
            // beside it and has to be told apart from the one under the cursor.
            // A second gray could not; the interface's own colour can.
            aria-current={row.selected ? "true" : undefined}
            className={`cursor-pointer border-b border-edge/40 transition-colors hover:bg-hover ${row.selected ? "bg-accent/[.09]" : ""}`}
            onClick={row.onOpen}
          >
            <td className="py-2.5 pr-4">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {/* The row is clickable for the mouse, but the keyboard needs
                      a real control to land on. */}
                  <button
                    type="button"
                    id={row.anchorId ? `${row.anchorId}-trigger` : undefined}
                    title={row.primaryTitle}
                    aria-label={activityRowAccessibleLabel({
                      name: row.primaryLabel,
                      time: fmtDuration(row.seconds),
                      comparison: `${((scale.totalSeconds > 0 ? row.seconds / scale.totalSeconds : 0) * 100).toFixed(
                        scale.totalSeconds > 0 && row.seconds / scale.totalSeconds < 0.1 ? 1 : 0,
                      )}% of recorded time in range`,
                      daysSeen: row.daysSeen,
                      lastSeen: formatLastSeen(row.lastSeen),
                      action: row.openLabel,
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      row.onOpen();
                    }}
                    className="min-w-0 truncate rounded-sm text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                  >
                    {row.primary}
                  </button>
                  {row.badges.map((badge) => (
                    <RowTag key={`${badge.label}:${badge.title}`} tone={badge.tone} title={badge.title}>
                      {badge.label}
                    </RowTag>
                  ))}
                </span>
                <span className="flex min-w-0 items-center gap-[5px] text-xs leading-[1.4] text-ink-3">
                  {row.metadata}
                </span>
              </span>
            </td>
            {!compactColumns && (
              <td className="py-2.5 pr-4">
                <ShareBar seconds={row.seconds} maxSeconds={scale.maxSeconds} totalSeconds={scale.totalSeconds} />
              </td>
            )}
            <td className="py-2.5 text-right tabular-nums text-ink-2">{fmtDuration(row.seconds)}</td>
            {!compactColumns && (
              <td className="py-2.5 pl-8 text-center tabular-nums text-ink-3">{row.daysSeen}</td>
            )}
            <td className="py-2.5 text-right tabular-nums text-ink-3">{formatLastSeen(row.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EntityCatalog({
  page,
  scale,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelect,
  onLoadMore,
  isAllTime,
  onTryAllTime,
  hasActiveFilters,
  onClearFilters,
}: {
  page: { rows: ActivityEntitySummary[]; total: number };
  scale: BarScale;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  isAllTime: boolean;
  onTryAllTime: () => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  if (page.total === 0) {
    return (
      <NoResults
        isAllTime={isAllTime}
        onTryAllTime={onTryAllTime}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={onClearFilters}
      />
    );
  }
  return (
    <>
      <EntityTable
        rows={page.rows}
        scale={scale}
        sort={sort}
        direction={direction}
        onSort={onSort}
        selectedEntityId={selectedEntityId}
        onSelect={onSelect}
      />
      {page.rows.length < page.total && <LoadMore shown={page.rows.length} total={page.total} onClick={onLoadMore} />}
    </>
  );
}

/**
 * Two groups, not three. Apps and websites are one table because they are one
 * table everywhere else: the unsearched catalog mixes them, every row already
 * says which it is on its metadata line, and the type filter above is the
 * control for narrowing to one. Splitting them cost a duplicated header row, a
 * second copy of the sort control that silently drove the first, one page limit
 * feeding two lists, and a **Load more** stranded below the table it grew.
 *
 * What remains separate is worth separating: identities and Windows are both
 * compact discovery rows, but answer different searches and open different
 * detail modes. Visit selection and deletion stay out of both tables.
 */
export function SearchResults({
  identities,
  windows,
  search,
  scale,
  sort,
  direction,
  onSort,
  windowSort,
  windowDirection,
  onWindowSort,
  selectedEntityId,
  selectedWindowKey,
  onSelectEntity,
  onSelectWindow,
  onLoadIdentities,
  onLoadWindows,
  isAllTime,
  onTryAllTime,
  hasActiveFilters,
  onClearFilters,
}: {
  identities: ActivityEntityPage;
  windows: ActivityTitleGroupPage;
  search: string;
  scale: BarScale;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  windowSort: ActivityWindowSort;
  windowDirection: ActivitySortDirection;
  onWindowSort: (field: ActivityWindowSort) => void;
  selectedEntityId: string | null;
  selectedWindowKey: string | null;
  onSelectEntity: (id: string) => void;
  onSelectWindow: (group: ActivityTitleGroup) => void;
  onLoadIdentities: () => void;
  onLoadWindows: () => void;
  isAllTime: boolean;
  onTryAllTime: () => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  if (identities.total === 0 && windows.total === 0) {
    return (
      <NoResults
        search={search}
        isAllTime={isAllTime}
        onTryAllTime={onTryAllTime}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={onClearFilters}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {identities.total > 0 && (
        <ResultGroup
          title="Apps and websites"
          summary={[
            countNoun(identities.total, "result"),
            identities.apps > 0 ? countNoun(identities.apps, "app") : null,
            identities.websites > 0 ? countNoun(identities.websites, "website") : null,
          ].filter((part): part is string => part !== null).join(" · ")}
        >
          <EntityTable
            rows={identities.rows}
            scale={scale}
            sort={sort}
            direction={direction}
            onSort={onSort}
            selectedEntityId={selectedEntityId}
            onSelect={onSelectEntity}
            headOffset="top-12"
          />
          {identities.rows.length < identities.total && (
            <LoadMore shown={identities.rows.length} total={identities.total} onClick={onLoadIdentities} />
          )}
        </ResultGroup>
      )}
      {windows.total > 0 && (
        <ResultGroup
          title="Windows"
          summary={`${countNoun(windows.total, "result")} · ${countNoun(windows.sessionTotal, "visit")}`}
        >
          <WindowGroupTable
            rows={windows.rows}
            search={search}
            scale={scale}
            sort={windowSort}
            direction={windowDirection}
            onSort={onWindowSort}
            selectedKey={selectedWindowKey}
            onSelect={onSelectWindow}
          />
          {/* Paging belongs to the list, so it stays against the table it extends. */}
          {windows.rows.length < windows.total && (
            <LoadMore shown={windows.rows.length} total={windows.total} onClick={onLoadWindows} />
          )}
        </ResultGroup>
      )}
    </div>
  );
}

/**
 * The heading sticks along with the table it names. Without it, scrolling deep
 * into either group left a column header stuck to the top that could have
 * belonged to either table — and at the handoff the incoming group's label was
 * the one thing hidden, sliding under the outgoing table's header.
 *
 * A true text-sm heading with stronger weight and ink keeps the section label
 * visibly above the compact table headings beneath it. Labeled totals sit on a
 * second line: unlike bare inline numbers, each quantity states what it counts.
 */
function ResultGroup({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="sticky top-0 z-20 flex h-12 items-center bg-surface">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-xs tabular-nums leading-[1.4] text-ink-3">
            <span>{summary}</span>
          </div>
        </div>
      </div>
      <div className="pt-1">{children}</div>
    </section>
  );
}

function EntityTable({
  rows,
  scale,
  sort,
  direction,
  onSort,
  selectedEntityId,
  onSelect,
  headOffset,
}: {
  rows: ActivityEntitySummary[];
  scale: BarScale;
  sort: ActivitySort;
  direction: ActivitySortDirection;
  onSort: (field: ActivitySort) => void;
  selectedEntityId: string | null;
  onSelect: (id: string) => void;
  headOffset?: string;
}) {
  const summarySort: SummaryTableSort = sort === "name" ? "label" : sort;
  const summaryRows: SummaryTableRow[] = rows.map((entity) => {
    const badges: SummaryTableBadge[] = [];
    if (entity.isNew) {
      badges.push({
        label: "New",
        title: "First seen in all of your history inside this date range.",
        tone: "accent",
      });
    }
    if (entity.noise) {
      badges.push({
        label: entity.noise === "utility" ? "Utility" : "Rare",
        title: entity.noise === "utility"
          ? "Looks like an installer, driver, or local file — normally hidden from this list."
          : "Seen briefly and rarely across all history — normally hidden from this list.",
      });
    }
    return {
      key: entity.id,
      anchorId: entityRowDomId(entity.id),
      primary: entity.displayName,
      primaryLabel: entity.displayName,
      primaryTitle: entity.key,
      metadata: (
        <>
          <ClassificationLabel entity={entity} />
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="shrink-0 capitalize">{entity.kind}</span>
        </>
      ),
      badges,
      seconds: entity.seconds,
      daysSeen: entity.daysSeen,
      lastSeen: entity.lastSeen,
      selected: selectedEntityId === entity.id,
      openLabel: "open details",
      onOpen: () => onSelect(entity.id),
    };
  });

  return (
    <div>
      <SummaryTable
        rows={summaryRows}
        tableLabel="Apps and websites"
        scale={scale}
        sort={summarySort}
        direction={direction}
        onSort={(field) => onSort(field === "label" ? "name" : field)}
        headOffset={headOffset}
      />
    </div>
  );
}

/** What every bar in one table is measured against: the heaviest row sets the
 *  length, the range total sets the share reported on hover. Kept together so
 *  the two can never be threaded through from different result sets. */
type BarScale = Pick<ActivityQueryResult, "maxSeconds" | "totalSeconds">;

/**
 * A filled pill and nothing else. The fill alone is what holds a tag apart
 * from the name beside it, which is why the border and the capitals both went:
 * each was a third and fourth way of saying "this is a badge", and together
 * they built a block twice the height of the word they annotated. Sentence
 * case also keeps them in the app's voice, and the shape matches the panel's
 * Corrected mark, the one tag that already existed.
 *
 * Colour and size are set here rather than inherited, since these sit on the
 * name's line and a tag taking its brightness would outshout it.
 *
 * Only two tones, and never one per tag: the label is already the distinction,
 * so hue would restate it — the same reason the category dot left this table.
 * "accent" marks a fact about the item worth noticing, "muted" a reason the
 * row is normally hidden. Accent is safe here because it is the interface's
 * own colour rather than any category's.
 */
export function RowTag({
  title,
  tone = "muted",
  children,
}: {
  title: string;
  tone?: "muted" | "accent";
  children: ReactNode;
}) {
  // The muted tone sits on surface-3, so it takes the raised ink rank.
  const styles = tone === "accent" ? "bg-accent/10 text-accent/85" : "bg-surface-3 text-ink-3-raised";
  return (
    <span
      // normal-case is defended, not decorative: the panel's eyebrow row is
      // uppercase, and a tag inheriting that loses the sentence case above.
      className={`shrink-0 rounded-full px-1.5 py-[1px] text-micro font-medium normal-case leading-[1.4] ${styles}`}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Length relative to the heaviest row the filters admit, as in Top Apps: a
 * full bar is "the most of anything here". Drawing the absolute share of all
 * recorded time is the more literal reading, but no single app is a large
 * fraction of a whole month — every row collapsed into the same short stub,
 * which is the one thing a bar exists to prevent. The absolute share is still
 * exact on hover, where a number can be read properly anyway.
 *
 * One accent fill: length is all the bar encodes, and the row's category is
 * already spelled out under its name.
 */
/**
 * Classification as the first thing on the row's metadata line. The word alone
 * carries it: a dot here would be a second encoding of what the label already
 * says, and the states that most need telling apart — uncategorized, partly
 * uncategorized, ignored — all share one gray, so it distinguished nothing
 * where it mattered most.
 */
function ClassificationLabel({ entity }: { entity: ActivityEntitySummary }) {
  if (entity.status === "uncategorized") return <span>Uncategorized</span>;
  if (entity.status === "partial") {
    // "Mixed" is the app's one word for "not one clean category", covering both
    // this and the several-categories case below. The tooltip carries what the
    // longer label used to say.
    return (
      <span title={`${fmtDuration(entity.uncategorizedSeconds)} of this is still uncategorized`}>
        Mixed
      </span>
    );
  }
  if (entity.status === "ignored") {
    return <span title="Recorded, but left out of every Insights total.">Ignored</span>;
  }
  const category = entity.categories[0];
  const label = entity.status === "mixed"
    ? `${category.name} +${entity.categories.length - 1}`
    : (category?.name ?? "Uncategorized");
  return (
    <span
      className="truncate"
      title={entity.status === "mixed"
        ? `Categorized differently across its sessions — ${entity.categories.map((slice) => `${slice.name} ${fmtDuration(slice.seconds)}`).join(", ")}`
        : undefined}
    >
      {label}
    </span>
  );
}

/**
 * Windows, not intervals.
 *
 * One row per distinct normalized full title, carrying how many times it was
 * returned to and how long that came to. The tracker's own unit — an
 * uninterrupted spell in the foreground — is the wrong thing to hand someone:
 * half of a real database's rows last under ten seconds and carry a few percent
 * of its time, so a search answered row by row buries what was asked for under
 * hundreds of fragments of the same window. The table stays a discovery list;
 * selecting a row moves interval-level work into the Window panel.
 */
function WindowGroupTable({
  rows,
  search,
  scale,
  sort,
  direction,
  onSort,
  selectedKey,
  onSelect,
}: {
  rows: ActivityTitleGroup[];
  search: string;
  scale: BarScale;
  sort: ActivityWindowSort;
  direction: ActivitySortDirection;
  onSort: (field: ActivityWindowSort) => void;
  selectedKey: string | null;
  onSelect: (group: ActivityTitleGroup) => void;
}) {
  const summarySort: SummaryTableSort = sort === "title" ? "label" : sort;
  const summaryRows: SummaryTableRow[] = rows.map((group) => {
    const classification = windowGroupClassification(group);
    return {
      key: group.key,
      primary: <MatchedTitle title={group.title} search={search} />,
      primaryLabel: group.title,
      primaryTitle: group.title,
      metadata: (
        <>
          <span className="shrink-0">{classification.label}</span>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="min-w-0 truncate" title={group.entityKey}>{group.displayName}</span>
          <span aria-hidden="true" className="shrink-0">·</span>
          <span className="shrink-0">{group.entityKind === "website" ? "Website" : "App"}</span>
        </>
      ),
      badges: group.isNew
        ? [{
            label: "New",
            title: "First seen in all of your history inside this date range.",
            tone: "accent" as const,
          }]
        : [],
      seconds: group.seconds,
      daysSeen: group.daysSeen,
      lastSeen: group.lastSeen,
      selected: selectedKey === group.key,
      openLabel: "open Window details",
      onOpen: () => onSelect(group),
    };
  });

  return (
    <div>
      <SummaryTable
        rows={summaryRows}
        tableLabel="Windows"
        scale={scale}
        sort={summarySort}
        direction={direction}
        onSort={(field) => onSort(field === "label" ? "title" : field)}
        headOffset="top-12"
      />
    </div>
  );
}

/**
 * Consecutive visits that fall on the same local date, in the order given.
 *
 * The list arrives newest-first and stays that way, so a single pass is enough
 * and no visit ever moves relative to its neighbours — a day heading is only a
 * break inserted where the date changes.
 */
/** The intervals behind one window, for the rare case that needs them: which
 *  exact visit to correct, or proof of when something actually happened. */
