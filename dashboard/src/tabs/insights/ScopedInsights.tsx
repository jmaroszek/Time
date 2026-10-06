import { CategoryDot, FloatingTooltip, MetricCard } from "../../components/ui";
import { uncategorizedMark } from "../../lib/chartTheme";
import { categoryState, type Category } from "../../lib/classify";
import { fmtDuration, fmtPct } from "../../lib/format";
import {
  parentScope,
  type InsightsScope,
  type ScopeNeighbor,
  type ScopeSummary,
  type ScopeTransitions,
  type ScopeWindow,
  type ScopeWindowList,
} from "../../lib/insightsScope";
import { RUN_DEFINITION } from "../../lib/runs";
import { useMeta } from "../../state/meta";

const KIND_LABELS = { app: "App", website: "Website", category: "Category" } as const;

/**
 * What the page is narrowed to, and the way back out.
 *
 * Every figure below means something different while a scope is set, so the
 * subject is stated once, at the top, as large as a card title's subject and
 * no larger — this is the page's heading, not a banner about it.
 *
 * An app or website held inside a category goes back to that category, one
 * step, rather than all the way out: it was reached from the category's list,
 * and that list is where the next comparison is.
 */
export function ScopeHeader({
  scope,
  category,
  onNavigate,
}: {
  scope: InsightsScope;
  /** The scope's own category, or the one most of an app's time resolved to. */
  category: Category | null;
  onNavigate: (scope: InsightsScope | null) => void;
}) {
  const meta = useMeta();
  const parent = parentScope(scope);
  const detail = scope.kind === "category"
    ? category
      ? capitalize(categoryState(category))
      : null
    : scope.within
      ? `${scope.within.name} only`
      : category?.name ?? "Uncategorized";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => onNavigate(parent)}
        className="-ml-1.5 flex min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
          <path d="M19 12H5m7-7-7 7 7 7" />
        </svg>
        <span className="truncate">{parent ? parent.name : "All activity"}</span>
      </button>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-edge" />
      <span className="flex min-w-0 items-center gap-2">
        <CategoryDot color={category?.color ?? uncategorizedMark(meta.theme)} />
        <h1 className="min-w-0 truncate text-lg font-semibold">{scope.name}</h1>
      </span>
      <span className="shrink-0 text-xs text-ink-3">
        {KIND_LABELS[scope.kind]}
        {detail && <> · {detail}</>}
      </span>
    </div>
  );
}

/**
 * The four tiles, for one subject instead of everything.
 *
 * The page's usual four are all productivity measures, which for a single app
 * restate its category. These answer what a single subject raises instead:
 * how much, how regularly, how often, and in what kind of stretch.
 */
export function ScopeTiles({
  scope,
  summary,
  rangeDays,
  previousDays,
}: {
  scope: InsightsScope;
  summary: ScopeSummary;
  rangeDays: number;
  previousDays: number;
}) {
  const change = summary.previousSeconds === null
    ? null
    : changeLabel(summary.seconds, summary.previousSeconds);
  // Held inside a category, the share is of that category: "a fifth of my
  // Entertainment" is the comparison its list was showing.
  const base = summary.parentSeconds ?? summary.trackedSeconds;
  const share = base > 0 ? summary.seconds / base : 0;
  const shareOf = scope.kind !== "category" && scope.within
    ? `of ${scope.within.name} in this range`
    : "of everything tracked in this range";
  const perDay = summary.daysUsed > 0 ? summary.runs / summary.daysUsed : null;
  const previousNote = summary.previousSeconds === null
    ? ""
    : ` ${fmtDuration(summary.previousSeconds)} in the previous ${previousDays} ${previousDays === 1 ? "day" : "days"}.`;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <MetricCard
        label="Time in range"
        value={(
          <span className="flex items-baseline gap-1.5 tabular-nums">
            {fmtDuration(summary.seconds)}
            {change && (
              <span className="text-xs font-normal tracking-normal text-ink-3">{change}</span>
            )}
          </span>
        )}
        hint={`${share > 0 && share < 0.01 ? "Under 1%" : fmtPct(share)} ${shareOf}.${previousNote}`}
      />
      <MetricCard
        label="Days used"
        value={(
          <span className="flex items-baseline gap-1.5 tabular-nums">
            {summary.daysUsed}
            <span className="text-xs font-normal tracking-normal text-ink-3">
              {`of ${rangeDays}`}
            </span>
          </span>
        )}
        hint={`Days with any time in ${scope.name}. Separates a daily habit from one long stretch.`}
      />
      <MetricCard
        label="Runs per day"
        value={perDay === null ? "—" : fmtRate(perDay)}
        hint={`Averaged over the days it was used. A run is one stretch of time in ${scope.name}. ${RUN_DEFINITION}`}
      />
      <MetricCard
        label="Typical run"
        value={summary.typicalRunSeconds === null ? "—" : fmtDuration(summary.typicalRunSeconds)}
        hint={summary.longestRunSeconds === null
          ? "Half of this time came in runs at least this long."
          : `Half of this time came in runs at least this long. The longest was ${fmtDuration(summary.longestRunSeconds)}.`}
      />
    </div>
  );
}

/**
 * The heaviest windows inside an app or website — what the time was *for*.
 *
 * Same row grammar as the ranked lists beside it, laid out for titles: the
 * title takes its own line, because a window title is the one label here long
 * enough that a fixed name column would cut off the part that identifies it.
 * A title opens that window in Activity, which is where a window is curated.
 */
export function TopWindowList({
  list,
  noun,
  onOpen,
}: {
  list: ScopeWindowList;
  noun: "app" | "website";
  onOpen?: (window: ScopeWindow) => void;
}) {
  if (list.rows.length === 0) {
    return list.untitledSeconds > 0 ? (
      <div className="flex h-[250px] flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium text-ink-2">No window titles recorded</p>
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-3">
          Time in this {noun} cannot be broken down by window. Title capture is off by
          default; Settings can turn it on for what is recorded from now on.
        </p>
      </div>
    ) : (
      <p className="py-8 text-center text-xs text-ink-3">No activity in range</p>
    );
  }
  const max = list.rows[0].seconds;
  const more = list.total - list.rows.length;
  const footer = [
    more > 0 ? `${more} more ${more === 1 ? "window" : "windows"}` : null,
    list.untitledSeconds >= 60 ? `${fmtDuration(list.untitledSeconds)} without a title` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div>
      <div
        className={`scroll-well flex flex-col gap-3 overflow-y-auto pr-2 sm:pr-4 ${footer ? "max-h-[231px]" : "max-h-[250px]"}`}
      >
        {list.rows.map((row) => (
          <div
            key={row.key}
            // As in the ranked lists: the row is the pointer's target as a
            // convenience, and the title is the control.
            onClick={onOpen ? () => onOpen(row) : undefined}
            className={`group text-xs ${onOpen ? "cursor-pointer" : ""}`}
          >
            <div className="flex items-baseline gap-3">
              {onOpen ? (
                <button
                  type="button"
                  title={`${row.title} · Open in Activity`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(row);
                  }}
                  className="min-w-0 flex-1 truncate rounded-sm text-left text-ink-2 underline-offset-2 outline-none group-hover:text-ink group-hover:underline focus-visible:underline"
                >
                  {row.title}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-ink-2" title={row.title}>
                  {row.title}
                </span>
              )}
              <span className="w-14 shrink-0 text-right tabular-nums text-ink-2">
                {fmtDuration(row.seconds)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent-data"
                style={{ width: `${Math.max((row.seconds / max) * 100, 1.5)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {footer && (
        <div className="mt-2 flex h-[15px] items-center">
          <p className="translate-y-px truncate text-xs text-ink-3">{footer}</p>
        </div>
      )}
    </div>
  );
}

/** Rows each side of the Before & After card lists. */
const TRANSITION_ROWS = 5;

/**
 * What the reader was doing right before a run of this subject began, and what
 * they went to when it ended.
 *
 * Shares are of runs, not of time: the question is what tends to lead here,
 * and a single long run would otherwise speak for every short one.
 */
export function TransitionsPanel({
  scope,
  transitions,
}: {
  scope: InsightsScope;
  transitions: ScopeTransitions;
}) {
  if (transitions.beforeRuns === 0 && transitions.afterRuns === 0) {
    return <p className="py-6 text-center text-xs text-ink-3">No runs in range</p>;
  }
  return (
    <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
      <TransitionColumn
        heading="Before"
        description={`What came right before each run of ${scope.name}`}
        neighbors={transitions.before}
        runs={transitions.beforeRuns}
      />
      <TransitionColumn
        heading="After"
        description={`What each run of ${scope.name} gave way to`}
        neighbors={transitions.after}
        runs={transitions.afterRuns}
      />
    </div>
  );
}

function TransitionColumn({
  heading,
  description,
  neighbors,
  runs,
}: {
  heading: string;
  description: string;
  neighbors: ScopeNeighbor[];
  runs: number;
}) {
  const meta = useMeta();
  const shown = neighbors.slice(0, TRANSITION_ROWS);
  const most = shown[0]?.runs ?? 1;
  return (
    <section aria-label={heading}>
      <h3 className="text-xs font-medium text-ink-2">{heading}</h3>
      <p className="mt-0.5 text-xs text-ink-3">{description}</p>
      {runs === 0 ? (
        <p className="mt-3 text-xs text-ink-3">Nothing recorded on this side of any run.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {shown.map((neighbor) => {
            const share = neighbor.runs / runs;
            const percent = share > 0 && share < 0.01 ? "<1%" : fmtPct(share);
            const count = `${neighbor.runs} of ${runs} ${runs === 1 ? "run" : "runs"}`;
            return (
              <div key={neighbor.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.75rem] items-center gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  {neighbor.kind === "break" ? (
                    // A break is not a category, so it gets an outline rather
                    // than a colour some category could also be wearing.
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full border border-ink-3" />
                  ) : (
                    <CategoryDot
                      color={neighbor.category?.color ?? uncategorizedMark(meta.theme)}
                      label={neighbor.category?.name ?? "Uncategorized"}
                    />
                  )}
                  <span className={`truncate ${neighbor.kind === "break" ? "text-ink-3" : "text-ink-2"}`} title={neighbor.name}>
                    {neighbor.name}
                  </span>
                </span>
                <span className="h-1.5 min-w-0 overflow-hidden rounded-full bg-surface-2">
                  <span
                    className="block h-full rounded-full bg-accent-data"
                    style={{ width: `${Math.max((neighbor.runs / most) * 100, 1.5)}%` }}
                  />
                </span>
                <FloatingTooltip
                  text={count}
                  ariaLabel={`${percent}, ${count}`}
                  className="text-right tabular-nums text-ink-2 outline-none"
                >
                  <span aria-hidden="true">{percent}</span>
                </FloatingTooltip>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Below a minute the previous period is not a base worth dividing by — the
 *  same judgment the ranked lists make when they say "new" instead. */
function changeLabel(current: number, previous: number): string | null {
  if (previous < 60) return current >= 60 ? "new" : null;
  const ratio = current / previous;
  if (ratio >= 10) return `${Math.round(ratio)}×`;
  const pct = Math.round((ratio - 1) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
}

/** One decimal while the decimal still says something. */
function fmtRate(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
