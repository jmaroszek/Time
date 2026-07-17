import { useMemo, useState } from "react";

import TimelineChart, { type TimelineSegment } from "../components/TimelineChart";
import TopAppsList from "../components/TopAppsList";
import ProductiveHoursChart from "../components/ProductiveHoursChart";
import { Card, MetricCard, Select, Spinner } from "../components/ui";
import {
  cleanProcessName,
  fmtClock,
  fmtDuration,
  fmtPct,
} from "../lib/format";
import {
  clipSessions,
  computeKpis,
  dailySecondsByApp,
  goalPace,
  topApps,
  withDeltas,
} from "../lib/metrics";
import { addDays, calendarDays, previousRange, type Range } from "../lib/time";
import type { PresetOrCustom } from "../components/DateRangePicker";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

export default function OverviewTab({
  range,
  preset,
}: {
  range: Range;
  preset: PresetOrCustom;
}) {
  const meta = useMeta();
  const [topN, setTopN] = useState<number | null>(null);
  const [selected, setSelected] = useState<TimelineSegment | null>(null);
  const [blockMinutes, setBlockMinutes] = useState(15);

  // One fetch covers the visible range, the previous period (deltas), and the
  // 6 days before the range (7-day rolling average).
  const prev = previousRange(range);
  const fetchStart = Math.min(prev.start.getTime(), addDays(range.start, -6).getTime()) / 1000;
  const fetchEnd = range.end.getTime() / 1000;
  const { sessions, loading, error } = useSessions(fetchStart, fetchEnd);

  const rangeStartSec = range.start.getTime() / 1000;
  const rangeEndSec = range.end.getTime() / 1000;

  const derived = useMemo(() => {
    // Sessions in ignored categories are invisible to every visualization
    // (they remain manageable in the Apps tab).
    const visible = sessions.filter((s) => meta.classifier(s)?.isIgnored !== true);
    const current = clipSessions(visible, rangeStartSec, rangeEndSec);
    const previous = clipSessions(
      visible,
      prev.start.getTime() / 1000,
      prev.end.getTime() / 1000,
    );
    const kpis = computeKpis(current, meta.classifier);
    const pace = goalPace(kpis.prodSec, range, meta.weeklyGoalHours);
    const n = topN ?? meta.defaultTopN;
    const apps = withDeltas(
      topApps(current, meta.classifier)
        .filter((a) => a.seconds >= meta.minAppSeconds)
        .slice(0, n),
      topApps(previous, meta.classifier),
      {
        currentDaily: dailySecondsByApp(current, range),
        previousDaily: dailySecondsByApp(previous, prev),
      },
    );
    const history = clipSessions(
      visible,
      addDays(range.start, -6).getTime() / 1000,
      rangeEndSec,
    );
    return { current, kpis, pace, apps, history };
  }, [sessions, rangeStartSec, rangeEndSec, prev.start, prev.end, meta, topN, range]);

  if (loading) return <Spinner />;
  if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const { kpis, pace, apps, current, history } = derived;
  const n = topN ?? meta.defaultTopN;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Avg Productive / Day"
          value={fmtDuration(kpis.prodSec / calendarDays(range))}
        />
        <MetricCard
          label="Productive"
          value={fmtPct(kpis.prodFraction)}
          sub={`${fmtDuration(kpis.prodSec)} of ${fmtDuration(kpis.totalSec)}`}
        />
        <MetricCard label="Longest Focus" value={fmtDuration(kpis.longestFocusSec)} />
        <MetricCard
          label="Goal Pace"
          value={`${pace.doneHours.toFixed(1)} / ${pace.targetHours.toFixed(0)}h`}
          sub={
            pace.remainingDays > 0
              ? pace.needPerDayHours > 0
                ? `need ${pace.needPerDayHours.toFixed(1)}h/day to hit goal`
                : "goal met"
              : pace.fraction >= 1
                ? "goal met"
                : `finished at ${fmtPct(pace.fraction)}`
          }
        />
      </div>

      <Card
        title="Timeline"
        right={
          <Select
            value={String(blockMinutes)}
            onChange={(v) => {
              setBlockMinutes(Number(v));
              setSelected(null);
            }}
            options={[
              { value: "0", label: "exact sessions" },
              { value: "5", label: "5 min blocks" },
              { value: "10", label: "10 min blocks" },
              { value: "15", label: "15 min blocks" },
              { value: "30", label: "30 min blocks" },
            ]}
          />
        }
      >
        <TimelineChart
          sessions={current}
          range={range}
          classifier={meta.classifier}
          blockMinutes={blockMinutes}
          onSelect={setSelected}
        />
        {selected && (
          <div className="mt-2 flex items-center gap-4 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs">
            <span className="font-semibold">
              {selected.isAfk
                ? "AFK"
                : selected.breakdown
                  ? selected.categoryName
                  : cleanProcessName(selected.process, meta.aliases)}
            </span>
            {!selected.breakdown && <span className="text-ink-2">{selected.categoryName}</span>}
            <span className="text-ink-2">
              {fmtClock(selected.startSec)}–{fmtClock(selected.endSec)} ·{" "}
              {fmtDuration(
                selected.breakdown
                  ? (selected.activeSec ?? 0)
                  : selected.endSec - selected.startSec,
              )}
              {selected.breakdown ? " active" : ""}
            </span>
            {selected.breakdown && !selected.isAfk && (
              <span className="flex-1 truncate text-ink-3">
                {selected.breakdown
                  .slice(0, 4)
                  .map((a) => `${cleanProcessName(a.process, meta.aliases)} ${fmtDuration(a.seconds)}`)
                  .join(" · ")}
              </span>
            )}
            {!selected.breakdown && selected.title && (
              <span className="flex-1 truncate text-ink-3" title={selected.title}>
                {selected.title}
              </span>
            )}
            <button
              type="button"
              className="text-ink-3 hover:text-ink"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Top Apps"
          right={
            <div className="flex items-center gap-2 text-xs text-ink-2">
              <span>vs previous period</span>
              <Select
                value={String(n)}
                onChange={(v) => setTopN(Number(v))}
                options={[5, 10, 15, 20].map((x) => ({ value: String(x), label: `Top ${x}` }))}
              />
            </div>
          }
        >
          <TopAppsList apps={apps} />
        </Card>
        <Card title="Daily Hours">
          <ProductiveHoursChart
            historySessions={history}
            range={range}
            classifier={meta.classifier}
            labelMode={preset === "last7" ? "weekday" : "date"}
          />
        </Card>
      </div>
    </div>
  );
}
