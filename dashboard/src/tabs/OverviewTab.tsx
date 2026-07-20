import { useEffect, useMemo, useState } from "react";

import ActivityCalendar from "../components/ActivityCalendar";
import HourlyActivityChart from "../components/HourlyActivityChart";
import MonthCalendarChart from "../components/MonthCalendarChart";
import RhythmChart from "../components/RhythmChart";
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
import {
  overviewGranularity,
  overviewHistoryStart,
  MONTH_CALENDAR_MIN_DAYS,
  ACTIVITY_METRICS,
  ACTIVITY_METRIC_LABELS,
  ACTIVITY_METRIC_WORDS,
  type ActivityMetric,
  type ActivityStack,
} from "../lib/overview";
import type { PresetOrCustom } from "../components/DateRangePicker";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

const HOURS_CARD_TITLES = {
  daily: "Daily Hours",
  weekly: "Weekly Hours",
  monthly: "Monthly Hours",
  yearly: "Yearly Hours",
} as const;

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
  // null = follow the range-length default; an explicit pick sticks until changed.
  const [aggregateView, setAggregateView] = useState<"rhythm" | "calendar" | null>(null);
  const [metric, setMetric] = useState<ActivityMetric>("tracked");
  const [stackBy, setStackBy] = useState<ActivityStack>("state");

  // One fetch covers the visible range, the previous period (deltas), and the
  // 6 days before the range (7-day rolling average).
  const prev = previousRange(range);
  const fetchStart = Math.min(prev.start.getTime(), addDays(range.start, -6).getTime()) / 1000;
  const fetchEnd = range.end.getTime() / 1000;
  const { sessions, loading, error } = useSessions(fetchStart, fetchEnd);

  const rangeStartSec = range.start.getTime() / 1000;
  const rangeEndSec = range.end.getTime() / 1000;
  const granularity = overviewGranularity(range);
  const rangeDays = calendarDays(range);
  const isSingleDay = rangeDays === 1;
  // The timeline stops being readable past ~two weeks of rows. Beyond that the
  // rhythm grid (collapsed into a typical week) and the calendar (every date
  // laid out) are both useful, so the range length picks the default and the
  // card header lets you override it.
  const middleView =
    rangeDays <= 14 ? "timeline" : (aggregateView ?? (rangeDays <= 30 ? "rhythm" : "calendar"));
  // Past ~14 months, day cells slice too thin; the calendar shows month cells
  // (years as rows) instead. Rhythm needs no such switch — it is always 7×24.
  const calendarByMonth = rangeDays >= MONTH_CALENDAR_MIN_DAYS;

  useEffect(() => setSelected(null), [rangeStartSec, rangeEndSec]);

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
    const kpis = computeKpis(current, meta.classifier, meta.focusChainMaxGapSeconds);
    const pace = goalPace(kpis.prodSec, range, meta.weeklyGoalHours);
    const n = topN ?? meta.defaultTopN;
    const rankedApps = topApps(current, meta.classifier);
    const eligibleApps = rankedApps.filter((a) => a.seconds >= meta.minAppSeconds);
    const apps = withDeltas(
      eligibleApps.slice(0, n),
      topApps(previous, meta.classifier),
      {
        currentDaily: dailySecondsByApp(current, range),
        previousDaily: dailySecondsByApp(previous, prev),
      },
    );
    const history = clipSessions(
      visible,
      overviewHistoryStart(range, granularity, meta.weekStart).getTime() / 1000,
      rangeEndSec,
    );
    return {
      current,
      kpis,
      pace,
      apps,
      hiddenAppCount: rankedApps.length - eligibleApps.length,
      history,
    };
  }, [sessions, rangeStartSec, rangeEndSec, prev.start, prev.end, meta, topN, range, granularity]);

  if (loading) return <Spinner />;
  if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  const { kpis, pace, apps, hiddenAppCount, current, history } = derived;
  const n = topN ?? meta.defaultTopN;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Daily productive time"
          value={fmtDuration(kpis.prodSec / calendarDays(range))}
          hint="Total productive time in this range divided by the number of days it spans."
        />
        <MetricCard
          label="Productive share"
          value={fmtPct(kpis.prodFraction)}
          hint="Share of tracked time spent in apps and sites you've marked productive."
        />
        <MetricCard
          label="Longest focus"
          value={fmtDuration(kpis.longestFocusSec)}
          hint="Longest continuous run of productive time. Short gaps don't break the chain."
        />
        <MetricCard
          label="Goal pace"
          value={meta.weeklyGoalHours > 0 ? `${pace.doneHours.toFixed(0)}h / ${pace.targetHours.toFixed(0)}h` : "Not set"}
          hint={meta.weeklyGoalHours > 0
            ? "Productive time in this range vs your weekly goal, prorated to the range's length."
            : "Set an optional weekly goal in Settings."}
        />
      </div>

      <Card
        title={middleView === "timeline"
          ? "Timeline"
          : middleView === "rhythm"
            ? (
                <span className="flex flex-col gap-0.5">
                  <span>Activity Rhythm</span>
                  <span className="text-[11px] font-normal text-ink-3">
                    {`Average ${ACTIVITY_METRIC_WORDS[metric]} time by weekday and hour`}
                  </span>
                </span>
              )
            : (
                <span className="flex flex-col gap-0.5">
                  <span>Activity Calendar</span>
                  <span className="text-[11px] font-normal text-ink-3">
                    {`${ACTIVITY_METRIC_WORDS[metric].replace(/^./, (c) => c.toUpperCase())} time by ${calendarByMonth ? "month" : "day"}`}
                  </span>
                </span>
              )}
        right={middleView === "timeline" ? (
          <Select
            value={String(blockMinutes)}
            onChange={(v) => {
              setBlockMinutes(Number(v));
              setSelected(null);
            }}
            options={[
              { value: "0", label: "Exact sessions" },
              { value: "5", label: "5 min blocks" },
              { value: "10", label: "10 min blocks" },
              { value: "15", label: "15 min blocks" },
              { value: "30", label: "30 min blocks" },
            ]}
          />
        ) : (
          <span className="flex items-center gap-2">
            <Select
              value={metric}
              onChange={(v) => setMetric(v as ActivityMetric)}
              options={ACTIVITY_METRICS.map((m) => ({
                value: m,
                label: ACTIVITY_METRIC_LABELS[m],
              }))}
            />
            <Select
              value={middleView}
              onChange={(v) => setAggregateView(v as "rhythm" | "calendar")}
              options={[
                { value: "rhythm", label: "Rhythm" },
                { value: "calendar", label: "Calendar" },
              ]}
            />
          </span>
        )}
      >
        {middleView === "timeline" ? (
          <TimelineChart
            sessions={current}
            range={range}
            classifier={meta.classifier}
            blockMinutes={blockMinutes}
            onSelect={setSelected}
          />
        ) : middleView === "rhythm" ? (
          <RhythmChart
            sessions={current}
            range={range}
            classifier={meta.classifier}
            metric={metric}
          />
        ) : calendarByMonth ? (
          <MonthCalendarChart
            sessions={current}
            range={range}
            classifier={meta.classifier}
            metric={metric}
          />
        ) : (
          <ActivityCalendar
            sessions={current}
            range={range}
            classifier={meta.classifier}
            metric={metric}
          />
        )}
        {middleView === "timeline" && selected && (
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
          className="h-[345px]"
          right={
            <Select
              value={String(n)}
              onChange={(v) => setTopN(Number(v))}
              options={[5, 10, 15, 20].map((x) => ({ value: String(x), label: `Top ${x}` }))}
            />
          }
        >
          <div className="pt-2">
            <TopAppsList
              apps={apps}
              comparisonDays={calendarDays(prev)}
              hiddenAppCount={apps.length < n ? hiddenAppCount : 0}
            />
          </div>
        </Card>
        <Card
          title={isSingleDay ? "Hourly Activity" : HOURS_CARD_TITLES[granularity]}
          className="h-[345px]"
          right={isSingleDay ? undefined : (
            <Select
              value={stackBy}
              onChange={(v) => setStackBy(v as ActivityStack)}
              options={[
                { value: "state", label: "Productivity" },
                { value: "category", label: "Categories" },
              ]}
            />
          )}
        >
          <div className="pt-2">
            {isSingleDay ? (
              <HourlyActivityChart
                sessions={current}
                range={range}
                classifier={meta.classifier}
                dayStartHour={meta.dayStartHour}
                dayEndHour={meta.dayEndHour}
              />
            ) : (
              <ProductiveHoursChart
                historySessions={history}
                range={range}
                classifier={meta.classifier}
                labelMode={preset === "last7" ? "weekday" : "date"}
                granularity={granularity}
                weekStart={meta.weekStart}
                stackBy={stackBy}
                categories={meta.categories}
              />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
