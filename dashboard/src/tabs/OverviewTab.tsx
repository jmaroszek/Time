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
import type { InsightsRequest } from "../lib/insights";
import { warmInsightsModel } from "../lib/insightsClient";
import { fetchSessions } from "../lib/queries";
import { loadSessionWindow } from "../lib/sessionWindowCache";
import {
  addDays,
  allTimeRange,
  calendarDays,
  previousRange,
  rangeForPreset,
  type Range,
} from "../lib/time";
import {
  MONTH_CALENDAR_MIN_DAYS,
  ACTIVITY_METRICS,
  ACTIVITY_METRIC_LABELS,
  ACTIVITY_METRIC_WORDS,
  type ActivityMetric,
  type ActivityStack,
} from "../lib/overview";
import type { PresetOrCustom } from "../components/DateRangePicker";
import { useMeta } from "../state/meta";
import { useInsightsModel } from "../state/useInsightsModel";
import { useSessions } from "../state/useSessions";

const HOURS_CARD_TITLES = {
  daily: "Daily Hours",
  weekly: "Weekly Hours",
  monthly: "Monthly Hours",
  yearly: "Yearly Hours",
} as const;

function insightsFetchWindow(range: Range): { startSec: number; endSec: number } {
  const previous = previousRange(range);
  return {
    startSec: Math.min(previous.start.getTime(), addDays(range.start, -6).getTime()) / 1000,
    endSec: range.end.getTime() / 1000,
  };
}

export default function OverviewTab({
  range,
  preset,
  firstSessionSec,
}: {
  range: Range;
  preset: PresetOrCustom;
  firstSessionSec: number | null;
}) {
  const meta = useMeta();
  const [topN, setTopN] = useState<number | null>(null);
  const [selected, setSelected] = useState<TimelineSegment | null>(null);
  const [blockMinutes, setBlockMinutes] = useState(15);
  // null = follow the range-length default; an explicit pick sticks until changed.
  const [aggregateView, setAggregateView] = useState<"rhythm" | "calendar" | null>(null);
  const [metric, setMetric] = useState<ActivityMetric>("tracked");
  const [stackBy, setStackBy] = useState<ActivityStack>("state");

  const { startSec: fetchStart, endSec: fetchEnd } = insightsFetchWindow(range);
  const sessionData = useSessions(fetchStart, fetchEnd);
  const request = useMemo<InsightsRequest | null>(() => {
    if (!sessionData.ready) return null;
    return {
      sessions: sessionData.sessions,
      range,
      categories: meta.categories,
      rules: meta.rules,
      browserProcesses: [...meta.browserSet].sort(),
      weekStart: meta.weekStart,
      weeklyGoalHours: meta.weeklyGoalHours,
      minAppSeconds: meta.minAppSeconds,
      focusChainMaxGapSeconds: meta.focusChainMaxGapSeconds,
      dayStartHour: meta.dayStartHour,
      dayEndHour: meta.dayEndHour,
      labelMode: preset === "last7" ? "weekday" : "date",
    };
  }, [sessionData.ready, sessionData.sessions, range, meta, preset]);
  const analyzed = useInsightsModel(request);
  const model = analyzed.model;

  // Warm the widest ordinary preset only after the current view is complete.
  // Its fetch covers the shorter nested presets too; model caching makes a
  // later Year switch a synchronous lookup rather than first-time work.
  useEffect(() => {
    if (!request || !analyzed.current) return;
    const yearRange = rangeForPreset("last365");
    const yearWindow = insightsFetchWindow(yearRange);
    let cancelled = false;
    const warm = () => {
      void (async () => {
        await loadSessionWindow(
          yearWindow.startSec,
          yearWindow.endSec,
          fetchSessions,
        );
        if (cancelled) return;
        // Shorter models reuse binary-searched slices of that one wide fetch.
        // Warm them smallest-first so the most common choices become ready
        // quickly while the worker continues with the larger horizons.
        for (const warmRange of [rangeForPreset("last30"), rangeForPreset("last90"), yearRange]) {
          const warmWindow = insightsFetchWindow(warmRange);
          const sessions = await loadSessionWindow(
            warmWindow.startSec,
            warmWindow.endSec,
            fetchSessions,
          );
          if (cancelled) return;
          await warmInsightsModel({
            ...request,
            sessions,
            range: warmRange,
            labelMode: "date",
          });
        }

        // Young databases fit inside the Year fetch. Warm their distinct
        // All-time model too, but never auto-load an older multi-year history.
        if (firstSessionSec !== null) {
          const allRange = allTimeRange(firstSessionSec);
          const allWindow = insightsFetchWindow(allRange);
          if (allWindow.startSec < yearWindow.startSec) return;
          const allSessions = await loadSessionWindow(
            allWindow.startSec,
            allWindow.endSec,
            fetchSessions,
          );
          if (cancelled) return;
          await warmInsightsModel({
            ...request,
            sessions: allSessions,
            range: allRange,
            labelMode: "date",
          });
        }
      })().catch(() => {});
    };
    const idle = window.requestIdleCallback?.(warm, { timeout: 3_000 });
    const timeout = idle === undefined ? window.setTimeout(warm, 500) : null;
    return () => {
      cancelled = true;
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [request, analyzed.current, firstSessionSec]);

  const displayedStartMs = model?.range.start.getTime() ?? null;
  const displayedEndMs = model?.range.end.getTime() ?? null;
  useEffect(() => setSelected(null), [displayedStartMs, displayedEndMs]);

  // Pin the aggregate view the first time the range is long enough to show one.
  // The range-length default is a starting point, not a rule: without this, any
  // change to the range's length (toggling Rolling on the same preset, say)
  // would silently move the picker off the view that's already on screen.
  const aggregateRangeDays = model && model.rangeDays > 14 ? model.rangeDays : null;
  useEffect(() => {
    if (aggregateRangeDays === null) return;
    setAggregateView((current) => current ?? (aggregateRangeDays <= 30 ? "rhythm" : "calendar"));
  }, [aggregateRangeDays]);

  if (!model) {
    const error = sessionData.error ?? analyzed.error;
    if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;
    return <Spinner />;
  }

  const displayRange = model.range;
  const prev = model.previous;
  const granularity = model.granularity;
  const rangeDays = model.rangeDays;
  const isSingleDay = rangeDays === 1;
  // The timeline stops being readable past ~two weeks of rows. Beyond that the
  // rhythm grid (collapsed into a typical week) and the calendar (every date
  // laid out) are both useful, so the range length picks the first default
  // (pinned above) and the card header lets you override it from then on.
  const middleView =
    rangeDays <= 14 ? "timeline" : (aggregateView ?? (rangeDays <= 30 ? "rhythm" : "calendar"));
  // Past ~14 months, day cells slice too thin; the calendar shows month cells
  // (years as rows) instead. Rhythm needs no such switch — it is always 7×24.
  const calendarByMonth = rangeDays >= MONTH_CALENDAR_MIN_DAYS;
  const currentDays = model.historyDays.filter(
    (day) => day.date >= displayRange.start && day.date < displayRange.end,
  );

  const n = topN ?? meta.defaultTopN;
  const apps = model.apps.slice(0, n);
  const updateError = sessionData.error ?? analyzed.error;
  const refreshing =
    !updateError &&
    (sessionData.refreshing || sessionData.loading || analyzed.refreshing || !analyzed.current);
  const { kpis, pace, hiddenAppCount } = model;

  return (
    <div className="relative flex flex-col gap-4" aria-busy={refreshing}>
      {updateError && (
        <span
          className="pointer-events-none absolute right-1 -top-3 text-[10px] text-bad"
          title={updateError}
        >
          Update failed
        </span>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Daily productive time"
          value={fmtDuration(kpis.prodSec / calendarDays(displayRange))}
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
            className="chart-select"
            blurOnChange
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
              className="chart-select"
              blurOnChange
              value={metric}
              onChange={(v) => setMetric(v as ActivityMetric)}
              options={ACTIVITY_METRICS.map((m) => ({
                value: m,
                label: ACTIVITY_METRIC_LABELS[m],
              }))}
            />
            <Select
              className="chart-select"
              blurOnChange
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
            sessions={model.timelineSessions ?? []}
            range={displayRange}
            classifier={meta.classifier}
            blockMinutes={blockMinutes}
            onSelect={setSelected}
          />
        ) : middleView === "rhythm" ? (
          <RhythmChart
            summary={model.rhythm!}
            metric={metric}
          />
        ) : calendarByMonth ? (
          <MonthCalendarChart
            summaries={model.monthly!}
            metric={metric}
          />
        ) : (
          <ActivityCalendar
            summaries={currentDays}
            range={displayRange}
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
              className="chart-select"
              blurOnChange
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
              comparisonAvailable={preset !== "alltime"}
              hiddenAppCount={apps.length < n ? hiddenAppCount : 0}
            />
          </div>
        </Card>
        <Card
          title={isSingleDay ? "Hourly Activity" : HOURS_CARD_TITLES[granularity]}
          className="h-[345px]"
          right={isSingleDay ? undefined : (
            <Select
              className="chart-select"
              blurOnChange
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
                hours={model.hourly!}
              />
            ) : (
              <ProductiveHoursChart
                historyDays={model.historyDays}
                range={displayRange}
                labelMode={model.labelMode}
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
