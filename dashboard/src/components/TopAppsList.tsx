// Top apps with quiet, direction-aware deltas vs the previous period. Category
// shows up once per row, in the dot beside the name.

import type { AppDelta } from "../lib/metrics";
import { fmtDuration } from "../lib/format";
import { uncategorizedMark } from "../lib/chartTheme";
import { useMeta } from "../state/meta";
import { CategoryDot, FloatingTooltip } from "./ui";

/**
 * Rows are read here, not edited. Naming an app is one app's business and lives
 * in its Activity panel; this list groups by the name that produces, so a row
 * can stand for several processes. An editor here would have been the only
 * control in Time that mutated several things at once, and everything it needed
 * to stay honest — a scope hint, a count in the confirmation, a warning that
 * clearing the name splits the row — was weight this list did not need to carry.
 */
export default function TopAppsList({
  apps,
  comparisonDays,
  comparisonAvailable,
  hiddenAppCount,
}: {
  apps: AppDelta[];
  comparisonDays: number;
  comparisonAvailable: boolean;
  hiddenAppCount: number;
}) {
  const meta = useMeta();
  const { browserSet, minAppSecondsPerDay } = meta;
  const max = apps[0]?.seconds ?? 1;
  return (
    <div>
      <div
        className={`scroll-well flex flex-col gap-2.5 overflow-y-auto pr-2 sm:pr-4 ${hiddenAppCount > 0 ? "max-h-[231px]" : "max-h-[250px]"}`}
      >
        {apps.map((app) => (
          <div
            key={app.key}
            className="top-app-row grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs sm:flex sm:gap-y-0"
          >
            <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 truncate sm:w-36 sm:shrink-0">
              <CategoryDot
                color={app.category?.color ?? uncategorizedMark(meta.theme)}
                label={app.category?.name ?? "Uncategorized"}
              />
              {/* Every process the row stands for. Usually one, and then this is
                  the raw executable behind a cleaned-up name; when a shared name
                  has merged several, it is the only place that says which. */}
              <span className="truncate" title={app.processes.join(", ")}>
                {app.name}
              </span>
            </span>
            <div className="col-span-3 row-start-2 h-2 min-w-0 overflow-hidden rounded-full bg-surface-2 sm:col-auto sm:row-auto sm:flex-1">
              {/* One accent fill for every bar: the dot already carries the
                  category, and hues of unequal visual weight made equal-length
                  bars read unequal — length is the only thing the bar encodes. */}
              <div
                className="h-full rounded-full bg-accent-data"
                style={{ width: `${Math.max((app.seconds / max) * 100, 1.5)}%` }}
              />
            </div>
            <span className="top-app-duration col-start-2 row-start-1 w-14 shrink-0 text-right text-ink-2">
              {fmtDuration(app.seconds)}
            </span>
            <DeltaBadge
              app={app}
              comparisonDays={comparisonDays}
              comparisonAvailable={comparisonAvailable}
              forceNeutral={app.processes.some((process) => browserSet.has(process.toLowerCase()))}
            />
          </div>
        ))}
        {apps.length === 0 && <p className="py-8 text-center text-ink-3">No activity in range</p>}
      </div>
      {hiddenAppCount > 0 && (
        <div className="mt-2 flex h-[15px] items-center">
          <p className="translate-y-px text-xs text-ink-3">
            {hiddenAppCount} {hiddenAppCount === 1 ? "app" : "apps"} under {fmtDuration(minAppSecondsPerDay)}/day hidden
          </p>
        </div>
      )}
    </div>
  );
}

/** Where a percentage stops reading as a quantity and becomes a wall of digits. */
const MULTIPLE_THRESHOLD = 10;

const period = (days: number) => `the previous ${days} ${days === 1 ? "day" : "days"}`;

function DeltaBadge({
  app,
  comparisonDays,
  comparisonAvailable,
  forceNeutral,
}: {
  app: AppDelta;
  comparisonDays: number;
  comparisonAvailable: boolean;
  forceNeutral: boolean;
}) {
  if (!comparisonAvailable) return null;
  // Every badge in this column is scoped to the comparison window, "new"
  // included: it means new to this period, not never seen before. Nothing here
  // reaches past the previous period, so a long-idle app reads the same as a
  // first-time one — the tooltip is where the two part ways.
  const span = `${fmtDuration(app.previousSeconds)} → ${fmtDuration(app.seconds)}`;
  // A baseline of nothing has no ratio, and one of near-nothing has no ratio
  // worth quoting: dividing 26h by three stray minutes yields +51698%.
  if (app.deltaFraction === null || app.baselineNegligible) {
    const tooltip =
      app.previousSeconds === 0
        ? `No time in ${period(comparisonDays)}`
        : `Barely used in ${period(comparisonDays)} (${span})`;
    return (
      <FloatingTooltip
        text={tooltip}
        className="top-app-change col-start-3 row-start-1 w-14 shrink-0 text-right text-xs font-normal tracking-tight text-ink-3 outline-none"
      >
        <span aria-hidden="true">new</span>
      </FloatingTooltip>
    );
  }
  // Past ten-fold a percentage stops reading as a quantity, so the unit changes
  // and the tooltip carries the two durations the badge no longer spells out.
  const ratio = app.seconds / app.previousSeconds;
  const pct = Math.round(app.deltaFraction * 100);
  const asMultiple = ratio >= MULTIPLE_THRESHOLD;
  const text = asMultiple
    ? `${Math.round(ratio)}×`
    : `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
  const cls =
    !forceNeutral && app.direction === "good"
      ? "text-good"
      : !forceNeutral && app.direction === "bad"
        ? "text-bad"
        : "text-ink-2";
  const tooltip = `${text} vs ${period(comparisonDays)}${asMultiple ? ` (${span})` : ""}${app.direction === "neutral" ? ", driven mostly by a single day" : ""}`;
  return (
    <FloatingTooltip
      text={tooltip}
      className={`top-app-change col-start-3 row-start-1 w-14 shrink-0 text-right text-xs font-normal tracking-tight tabular-nums outline-none ${cls}`}
    >
      <span aria-hidden="true">{text}</span>
    </FloatingTooltip>
  );
}
