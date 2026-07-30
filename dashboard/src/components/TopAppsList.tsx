// Top apps with quiet, direction-aware deltas vs the previous period. Category
// shows up once per row, in the dot beside the name.

import { useState } from "react";

import type { AppDelta } from "../lib/metrics";
import { withAlias } from "../lib/aliases";
import { cleanProcessName, fmtDuration } from "../lib/format";
import { saveProcessAliases } from "../lib/queries";
import { useBanner } from "../state/banner";
import { uncategorizedMark } from "../lib/chartTheme";
import { useMeta } from "../state/meta";
import { CategoryDot, FloatingTooltip } from "./ui";

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
  const banner = useBanner();
  const { aliases, browserSet, minAppSecondsPerDay } = meta;
  const [editingProcess, setEditingProcess] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const max = apps[0]?.seconds ?? 1;
  const beginRename = (process: string) => {
    setEditingProcess(process);
    setAliasDraft(aliases[process.toLowerCase()] ?? "");
  };
  const commitRename = async (process: string) => {
    const key = process.toLowerCase();
    const alias = aliasDraft.trim();
    const currentAlias = aliases[key] ?? "";
    setEditingProcess(null);
    if (alias === currentAlias) return;
    const nextAliases = withAlias(aliases, key, alias);
    try {
      await saveProcessAliases(nextAliases);
      await meta.refresh();
    } catch (error) {
      banner.report(error, "name");
    }
  };
  return (
    <div>
      <div
        className={`scroll-well flex flex-col gap-2.5 overflow-y-auto pr-2 sm:pr-4 ${hiddenAppCount > 0 ? "max-h-[231px]" : "max-h-[250px]"}`}
      >
        {apps.map((app) => (
          <div
            key={app.process}
            className="top-app-row grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 text-xs sm:flex sm:gap-y-0"
          >
            <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 truncate sm:w-36 sm:shrink-0">
              <CategoryDot
                color={app.category?.color ?? uncategorizedMark(meta.theme)}
                label={app.category?.name ?? "Uncategorized"}
              />
              {editingProcess === app.process ? (
                <input
                  autoFocus
                  value={aliasDraft}
                  aria-label={`Rename ${cleanProcessName(app.process)}`}
                  placeholder={cleanProcessName(app.process)}
                  onChange={(event) => setAliasDraft(event.target.value)}
                  onBlur={() => void commitRename(app.process)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRename(app.process);
                    else if (event.key === "Escape") setEditingProcess(null);
                  }}
                  className="w-full min-w-0 rounded-md border border-control-edge bg-control px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent/60"
                />
              ) : (
                <span
                  className="truncate cursor-text"
                  title={`${app.process} — double-click to rename`}
                  onDoubleClick={() => beginRename(app.process)}
                >
                  {cleanProcessName(app.process, aliases)}
                </span>
              )}
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
              forceNeutral={browserSet.has(app.process.toLowerCase())}
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
