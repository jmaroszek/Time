// Top apps with quiet, category-aware deltas vs the previous period.

import { useState } from "react";

import type { AppDelta } from "../lib/metrics";
import { withAlias } from "../lib/aliases";
import { cleanProcessName, fmtDuration } from "../lib/format";
import { saveProcessAliases } from "../lib/queries";
import { useBanner } from "../state/banner";
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
        className={`flex flex-col gap-2.5 overflow-y-auto pr-3 ${hiddenAppCount > 0 ? "max-h-[231px]" : "max-h-[250px]"}`}
      >
        {apps.map((app) => (
          <div key={app.process} className="flex items-center gap-3 text-xs">
            <span className="flex w-36 shrink-0 items-center gap-2 truncate">
              <CategoryDot color={app.category?.color ?? "#5b616b"} />
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
                  className="w-full min-w-0 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent/60"
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
          <p className="translate-y-px text-[11px] text-ink-3">
            {hiddenAppCount} {hiddenAppCount === 1 ? "app" : "apps"} under {fmtDuration(minAppSecondsPerDay)}/day hidden
          </p>
        </div>
      )}
    </div>
  );
}

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
  if (app.deltaFraction === null) {
    return <span className="w-14 shrink-0 text-right text-[11px] text-ink-3">new</span>;
  }
  const pct = Math.round(app.deltaFraction * 100);
  const text = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
  const cls =
    !forceNeutral && app.direction === "good"
      ? "text-good"
      : !forceNeutral && app.direction === "bad"
        ? "text-bad"
        : "text-ink-2";
  const period = `the previous ${comparisonDays} ${comparisonDays === 1 ? "day" : "days"}`;
  const tooltip = `${text} vs ${period}${app.direction === "neutral" ? ", driven mostly by a single day" : ""}`;
  return (
    <FloatingTooltip
      text={tooltip}
      className={`w-14 shrink-0 text-right text-[11px] font-normal tracking-tight tabular-nums outline-none ${cls}`}
    >
      <span aria-hidden="true">{text}</span>
    </FloatingTooltip>
  );
}
