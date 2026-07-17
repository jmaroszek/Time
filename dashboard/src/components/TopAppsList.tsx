// Top apps with quiet, category-aware deltas vs the previous period.

import type { AppDelta } from "../lib/metrics";
import { cleanProcessName, fmtDuration } from "../lib/format";
import { useMeta } from "../state/meta";
import { CategoryDot } from "./ui";

export default function TopAppsList({ apps }: { apps: AppDelta[] }) {
  const { aliases } = useMeta();
  const max = apps[0]?.seconds ?? 1;
  return (
    <div className="flex flex-col gap-2.5">
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
          <DeltaBadge app={app} />
        </div>
      ))}
      {apps.length === 0 && <p className="py-8 text-center text-ink-3">No activity in range</p>}
    </div>
  );
}

function DeltaBadge({ app }: { app: AppDelta }) {
  if (app.deltaFraction === null) {
    return <span className="w-14 shrink-0 text-center text-[11px] text-ink-3">new</span>;
  }
  const pct = Math.round(app.deltaFraction * 100);
  const text = `${pct > 0 ? "▲ " : pct < 0 ? "▼ " : ""}${Math.abs(pct)}%`;
  const cls =
    app.direction === "good"
      ? "text-[#5fc296]"
      : app.direction === "bad"
        ? "text-[#e08787]"
        : "text-ink-2";
  return (
    <span
      className={`w-14 shrink-0 text-right text-[11px] font-normal ${cls}`}
      title={
        "vs the equal-length period before; gray = not statistically significant" +
        (app.pValue !== null ? ` (p=${app.pValue.toFixed(3)})` : "")
      }
    >
      {text}
    </span>
  );
}
