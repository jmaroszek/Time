// Top apps with quiet, category-aware deltas vs the previous period.

import type { AppDelta } from "../lib/metrics";
import { cleanProcessName, fmtDuration } from "../lib/format";
import { useMeta } from "../state/meta";
import { CategoryDot } from "./ui";

export default function TopAppsList({
  apps,
  comparisonDays,
  hiddenAppCount,
}: {
  apps: AppDelta[];
  comparisonDays: number;
  hiddenAppCount: number;
}) {
  const { aliases, minAppSeconds } = useMeta();
  const max = apps[0]?.seconds ?? 1;
  return (
    <div>
      <div
        className={`flex flex-col gap-2.5 overflow-y-auto pr-3 ${hiddenAppCount > 0 ? "max-h-[231px]" : "max-h-[250px]"}`}
      >
        {apps.map((app) => (
          <div key={app.process} className="flex items-center gap-3 text-xs">
            <span className="flex w-36 shrink-0 items-center gap-2 truncate" title={app.process}>
              <CategoryDot color={app.category?.color ?? "#5b616b"} />
              <span className="truncate">{cleanProcessName(app.process, aliases)}</span>
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max((app.seconds / max) * 100, 1.5)}%`,
                  backgroundColor: app.category?.color ?? "#5b616b",
                }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-ink-2">{fmtDuration(app.seconds)}</span>
            <DeltaBadge app={app} comparisonDays={comparisonDays} />
          </div>
        ))}
        {apps.length === 0 && <p className="py-8 text-center text-ink-3">No activity in range</p>}
      </div>
      {hiddenAppCount > 0 && (
        <div className="mt-2 flex h-[15px] items-center">
          <p className="translate-y-px text-[11px] text-ink-3">
            {hiddenAppCount} {hiddenAppCount === 1 ? "app" : "apps"} under {fmtDuration(minAppSeconds)} hidden
          </p>
        </div>
      )}
    </div>
  );
}

function DeltaBadge({ app, comparisonDays }: { app: AppDelta; comparisonDays: number }) {
  if (app.deltaFraction === null) {
    return <span className="w-14 shrink-0 text-right text-[11px] text-ink-3">new</span>;
  }
  const pct = Math.round(app.deltaFraction * 100);
  const text = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
  const cls =
    app.direction === "good"
      ? "text-good"
      : app.direction === "bad"
        ? "text-bad"
        : "text-ink-2";
  const period = `the previous ${comparisonDays} ${comparisonDays === 1 ? "day" : "days"}`;
  const tooltip = `${text} vs ${period}${app.direction === "neutral" ? ", driven mostly by a single day" : ""}`;
  return (
    <span
      className={`w-14 shrink-0 text-right text-[11px] font-normal tracking-tight tabular-nums ${cls}`}
      aria-label={`${pct > 0 ? "increased" : pct < 0 ? "decreased" : "unchanged"} ${Math.abs(pct)} percent`}
      title={tooltip}
    >
      <span aria-hidden="true">{text}</span>
    </span>
  );
}
