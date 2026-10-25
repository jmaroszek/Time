import { MetricCard } from "../../components/ui";
import { appSuffixNames, trimAppSuffix } from "../../lib/activityFormat";
import { goalTargetLabel, type GoalProgress } from "../../lib/categoryGoals";
import { fmtDuration, fmtDurationTitle, fmtPct } from "../../lib/format";
import { RUN_DEFINITION } from "../../lib/runs";
import {
  type InsightsScope,
  type ScopeSummary,
  type ScopeWindow,
  type ScopeWindowList,
} from "../../lib/insightsScope";
import { GoalMark } from "./GoalMark";

/**
 * The four tiles, for one subject instead of everything.
 *
 * The page's usual four are all productivity measures, which for a single app
 * restate its category. These answer what a single subject raises instead:
 * how much, how much of the whole, how often, and in what kind of stretch.
 * Which days it was used is the calendar's to show, so the count of them
 * rides in the time tile's hover text.
 */
export function ScopeTiles({
  scope,
  summary,
  rangeDays,
  previousDays,
  goal,
}: {
  scope: InsightsScope;
  summary: ScopeSummary;
  rangeDays: number;
  previousDays: number;
  /** A category's weekly goal over this range, when it has one. */
  goal?: GoalProgress;
}) {
  const change = summary.previousSeconds === null
    ? null
    : changeLabel(summary.seconds, summary.previousSeconds);
  // Held inside a category, the share is of that category: "a fifth of my
  // Entertainment" is the comparison its list was showing.
  const base = summary.parentSeconds ?? summary.trackedSeconds;
  const share = base > 0 ? summary.seconds / base : null;
  const parentName = scope.kind !== "category" && scope.within ? scope.within.name : null;
  const perDay = summary.daysUsed > 0 ? summary.runs / summary.daysUsed : null;
  // On a single day the count is always 1 or 0, and the average is the figure.
  // Otherwise the average spreads over every day in the range, as Daily
  // productive time does, and the count beside it says how thinly.
  const daysNote = rangeDays <= 1
    ? `Time in ${scope.name} on this day.`
    : summary.seconds > 0
      ? `About ${fmtDuration(summary.seconds / rangeDays)} a day, used on ${summary.daysUsed} of ${rangeDays} days.`
      : `Used on 0 of ${rangeDays} days.`;
  const previousNote = summary.previousSeconds === null
    ? ""
    : ` ${fmtDuration(summary.previousSeconds)} in the previous ${previousDays} ${previousDays === 1 ? "day" : "days"}.`;
  // With a goal, the target takes the small slot beside the figure, exactly as
  // on Goal pace, and the change moves into the hover text rather than
  // onto a caption line under the figure.
  const changeNote = goal && change
    ? `${change === "new" ? "New" : change} vs the previous ${previousDays} ${previousDays === 1 ? "day" : "days"}. `
    : "";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <MetricCard
        label="Time in range"
        value={(
          <span className="flex items-baseline gap-1.5 tabular-nums" title={fmtDurationTitle(summary.seconds)}>
            {fmtDuration(summary.seconds)}
            {goal ? (
              <span className="flex items-center gap-1.5 text-xs font-normal tracking-normal text-ink-3">
                {goalTargetLabel(goal)}
                {(goal.met || goal.missed) && <GoalMark missed={goal.missed} limit={goal.kind === "at_most"} />}
              </span>
            ) : change && (
              <span className="text-xs font-normal tracking-normal text-ink-3">{change}</span>
            )}
          </span>
        )}
        hint={`${changeNote}${daysNote}${previousNote}`}
      />
      <MetricCard
        label="Share"
        value={share === null ? "—" : (
          <span className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
            {share > 0 && share < 0.01 ? "<1%" : fmtPct(share)}
            <span className="truncate text-xs font-normal tracking-normal text-ink-3">
              {`of ${parentName ?? "everything"}`}
            </span>
          </span>
        )}
        hint={parentName
          ? `Share of ${parentName}'s time in this range that was spent in ${scope.name}.`
          : `Share of everything tracked in this range that was spent in ${scope.name}.`}
      />
      <MetricCard
        label="Runs per day"
        value={perDay === null ? "—" : fmtRate(perDay)}
        hint={`Average number of separate sittings in ${scope.name} on the days you used it. ${RUN_DEFINITION}`}
      />
      <MetricCard
        label="Typical run"
        value={summary.typicalRunSeconds === null ? "—" : fmtDuration(summary.typicalRunSeconds)}
        hint={summary.longestRunSeconds === null
          ? `Half your time in ${scope.name} was spent in runs at least this long.`
          : `Half your time in ${scope.name} was spent in runs at least this long. Longest run: ${fmtDuration(summary.longestRunSeconds)}.`}
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
  scopeName,
  scopeKey,
  noun,
  titlesStored,
  onStoreTitles,
  onOpen,
}: {
  list: ScopeWindowList;
  /** The subject's name and key, which its windows' titles tend to end with:
   *  "Notes - Obsidian - Obsidian 1.14.4". Trimmed off as the Activity panel
   *  trims them, so the part that tells windows apart is what shows. */
  scopeName: string;
  scopeKey: string;
  noun: "app" | "website";
  /** Whether "Store window titles" is on now, which decides whether an empty
   *  list is a setting to change or just this subject having no titles. */
  titlesStored: boolean;
  onStoreTitles: () => void;
  onOpen?: (window: ScopeWindow) => void;
}) {
  if (list.rows.length === 0) {
    return list.untitledSeconds > 0 ? (
      <div className="flex h-[250px] flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium text-ink-2">No window titles in this range</p>
        {titlesStored ? (
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-3">
            This {noun}&apos;s time was recorded without titles, so it cannot be broken
            down by window. Titles are stored for what is recorded from now on.
          </p>
        ) : (
          <>
            <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-3">
              With window titles stored, this card lists what the time in this {noun} was
              spent on: documents, pages, conversations. Titles stay on this computer, and
              only what is recorded after turning them on is broken down.
            </p>
            <button
              type="button"
              onClick={onStoreTitles}
              className="mt-3 text-xs text-accent transition-colors hover:underline hover:decoration-accent/50 hover:underline-offset-4"
            >
              Store window titles
            </button>
          </>
        )}
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
        {list.rows.map((row) => {
          // An app scope can gather several processes under one alias, so each
          // row also offers the process its own window came from. Only a
          // process: in a browser's scope a row's entity is often the website,
          // and "— docs.example.com" is what tells its windows apart.
          const ownProcess = row.entityId.startsWith("app:")
            ? appSuffixNames("", row.entityId.slice("app:".length))
            : [];
          const shown = trimAppSuffix(row.title, [
            ...appSuffixNames(scopeName, scopeKey),
            ...ownProcess,
          ]);
          return (
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
                  className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-ink-2 outline-none group-hover:text-ink focus-visible:text-ink focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  {shown}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-ink-2" title={row.title}>
                  {shown}
                </span>
              )}
              <span className="w-14 shrink-0 text-right tabular-nums text-ink-2" title={fmtDurationTitle(row.seconds)}>
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
          );
        })}
      </div>
      {footer && (
        <div className="mt-2 flex h-[15px] items-center">
          <p className="translate-y-px truncate text-xs text-ink-3">{footer}</p>
        </div>
      )}
    </div>
  );
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
