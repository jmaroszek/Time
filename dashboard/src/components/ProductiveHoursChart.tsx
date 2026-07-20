// Adaptive activity hours: daily, weekly, or monthly productivity-state stacks
// plus a same-scale trailing average of productive time. `historySessions`
// includes the preceding periods needed to make the first visible average real.

import { useMemo } from "react";

import type { Category, Classifier } from "../lib/classify";
import { rollingMean, type Session } from "../lib/metrics";
import {
  bucketActivityHours,
  dailyActivitySummaries,
  isCompleteHoursBucket,
  overviewHistoryStart,
  UNCATEGORIZED_LABEL,
  type ActivityStack,
  type HoursBucket,
  type OverviewGranularity,
} from "../lib/overview";
import { addDays, type Range } from "../lib/time";
import type { WeekStart } from "../lib/time";
import { fmtShortDate } from "../lib/format";
import EChart, { type EChartsOption } from "./EChart";
import {
  ANNOTATION,
  CHROME,
  NEUTRAL_BAR,
  PRODUCTIVE_BAR,
  TOOLTIP_STYLE,
  UNCATEGORIZED,
  UNCATEGORIZED_BAR,
  UNPRODUCTIVE_BAR,
} from "../lib/chartTheme";

export interface CategorySeries {
  name: string;
  color: string;
  /** Hours per bucket, in the order the buckets were given. */
  hours: number[];
}

/**
 * Category stacks for a run of buckets, ordered by total time so the largest
 * segment forms the stable base of every bar. Configured order breaks ties.
 *
 * Ignored categories never reach here — their sessions are dropped upstream —
 * and categories with no time in the range are omitted rather than crowding
 * the legend with flat zeroes.
 */
export function categorySeries(
  buckets: { categorySeconds: Map<string, number> }[],
  categories: Category[],
): CategorySeries[] {
  const ordered: { name: string; color: string }[] = [
    ...categories.filter((category) => !category.isIgnored),
    { name: UNCATEGORIZED_LABEL, color: UNCATEGORIZED },
  ];
  const out: Array<CategorySeries & { configuredIndex: number; totalSeconds: number }> = [];
  for (const [configuredIndex, { name, color }] of ordered.entries()) {
    const totalSeconds = buckets.reduce(
      (total, bucket) => total + (bucket.categorySeconds.get(name) ?? 0),
      0,
    );
    const hours = buckets.map(
      (bucket) => Math.round(((bucket.categorySeconds.get(name) ?? 0) / 3600) * 100) / 100,
    );
    if (totalSeconds > 0) out.push({ name, color, hours, configuredIndex, totalSeconds });
  }
  return out
    .sort((a, b) => b.totalSeconds - a.totalSeconds || a.configuredIndex - b.configuredIndex)
    .map(({ name, color, hours }) => ({ name, color, hours }));
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRODUCTIVE_AVERAGES = {
  daily: "7-day productive avg",
  weekly: "4-week productive avg",
  monthly: "3-month productive avg",
  yearly: "3-year productive avg",
} as const;
/** Trailing periods averaged for the dashed line, per non-daily granularity. */
const AVERAGE_WINDOWS = { weekly: 4, monthly: 3, yearly: 3 } as const;
const MIN_UNCATEGORIZED_SERIES_HOURS = 1;

export default function ProductiveHoursChart({
  historySessions,
  range,
  classifier,
  labelMode = "date",
  granularity = "daily",
  weekStart = "Sunday",
  stackBy = "state",
  categories = [],
}: {
  historySessions: Session[];
  range: Range;
  classifier: Classifier;
  labelMode?: "weekday" | "date";
  granularity?: OverviewGranularity;
  weekStart?: WeekStart;
  stackBy?: ActivityStack;
  categories?: Category[];
}) {
  const option = useMemo<EChartsOption>(() => {
    const round2 = (h: number) => Math.round(h * 100) / 100;
    let labels: string[];
    let prodBars: number[];
    let neutralBars: number[];
    let unproductiveBars: number[];
    let uncategorizedBars: number[];
    let avgLine: Array<number | null>;
    let tooltipHeaders: string[];
    let buckets: HoursBucket[] = [];
    // Whichever bucket run is on screen, for the category stacks.
    let visible: { categorySeconds: Map<string, number> }[] = [];
    const averageName = PRODUCTIVE_AVERAGES[granularity];

    if (granularity === "daily") {
      const historyRange = {
        start: overviewHistoryStart(range, granularity, weekStart),
        end: range.end,
      };
      const historyDays = dailyActivitySummaries(historySessions, historyRange, classifier);
      const visibleDays = dailyActivitySummaries(historySessions, range, classifier);
      visible = visibleDays;
      const offset = historyDays.length - visibleDays.length;
      labels = visibleDays.map((day) =>
        labelMode === "weekday" ? DAY_NAMES[day.date.getDay()] : fmtShortDate(day.date),
      );
      tooltipHeaders = visibleDays.map((day) =>
        labelMode === "weekday" ? FULL_DAY_NAMES[day.date.getDay()] : fmtShortDate(day.date),
      );
      prodBars = visibleDays.map((day) => round2(day.productiveSeconds / 3600));
      neutralBars = visibleDays.map((day) => round2(day.neutralSeconds / 3600));
      unproductiveBars = visibleDays.map((day) => round2(day.unproductiveSeconds / 3600));
      uncategorizedBars = visibleDays.map((day) => round2(day.uncategorizedSeconds / 3600));
      avgLine = rollingMean(historyDays.map((day) => day.productiveSeconds / 3600), 7)
        .slice(offset)
        .map(round2);
    } else {
      const days = dailyActivitySummaries(historySessions, range, classifier);
      buckets = bucketActivityHours(days, range, granularity, weekStart);
      visible = buckets;
      const historyRange = {
        start: overviewHistoryStart(range, granularity, weekStart),
        end: range.end,
      };
      const historyDays = dailyActivitySummaries(historySessions, historyRange, classifier);
      const historyBuckets = bucketActivityHours(historyDays, historyRange, granularity, weekStart);
      const averageWindow = AVERAGE_WINDOWS[granularity];
      const averages = rollingMean(
        historyBuckets.map((bucket) => bucket.productiveSeconds / 3600),
        averageWindow,
      );
      const averageByKey = new Map(historyBuckets.map((bucket, index) => [bucket.key, round2(averages[index])]));
      labels = buckets.map((bucket) => {
        if (granularity === "weekly") return fmtShortDate(bucket.periodStart);
        if (granularity === "yearly") return String(bucket.periodStart.getFullYear());
        return `${MONTH_NAMES[bucket.periodStart.getMonth()]} '${String(bucket.periodStart.getFullYear()).slice(-2)}`;
      });
      tooltipHeaders = buckets.map((bucket) => {
        const period = granularity === "weekly" ? "week" : granularity === "yearly" ? "year" : "month";
        const partial = isCompleteHoursBucket(bucket, granularity) ? "" : ` · partial ${period}`;
        return `${formatHoursBucketRange(bucket)}${partial}`;
      });
      prodBars = buckets.map((bucket) => round2(bucket.productiveSeconds / 3600));
      neutralBars = buckets.map((bucket) => round2(bucket.neutralSeconds / 3600));
      unproductiveBars = buckets.map((bucket) => round2(bucket.unproductiveSeconds / 3600));
      uncategorizedBars = buckets.map((bucket) => round2(bucket.uncategorizedSeconds / 3600));
      avgLine = buckets.map((bucket) =>
        isCompleteHoursBucket(bucket, granularity) ? (averageByKey.get(bucket.key) ?? null) : null,
      );
    }

    const hasUncategorized = shouldShowUncategorized(uncategorizedBars);
    const stateStacks: CategorySeries[] = [
      { name: "Productive", color: PRODUCTIVE_BAR, hours: prodBars },
      { name: "Neutral", color: NEUTRAL_BAR, hours: neutralBars },
      { name: "Unproductive", color: UNPRODUCTIVE_BAR, hours: unproductiveBars },
      ...(hasUncategorized
        ? [{ name: "Uncategorized", color: UNCATEGORIZED_BAR, hours: uncategorizedBars }]
        : []),
    ];
    const categoryStacks = categorySeries(visible, categories);
    const stacks = stackBy === "category" ? categoryStacks : stateStacks;
    const stackNames = stacks.map((stack) => stack.name);
    const showProductiveAverage = stackBy === "state";
    const tooltip = {
      trigger: "axis" as const,
      ...TOOLTIP_STYLE,
      formatter: (params: Array<{ axisValueLabel: string; dataIndex: number; marker: string; seriesName: string; value: number }>) => {
        if (!params.length) return "";
        const byName = new Map(params.map((p) => [p.seriesName, p]));
        const rows = [...(showProductiveAverage ? [averageName] : []), ...stackNames]
          .map((name) => byName.get(name))
          .filter((p): p is NonNullable<typeof p> => p !== undefined)
          .map((p) => `${p.marker}${p.seriesName}: <b>${formatHoursTooltipValue(p.value)}</b>`);
        return [`<b>${tooltipHeaders[params[0].dataIndex]}</b>`, ...rows].join("<br/>");
      },
    };

    const averageLegend = {
      name: averageName,
      icon: "path://M0,4 L4,4 L4,6 L0,6 Z M6,4 L10,4 L10,6 L6,6 Z M12,4 L16,4 L16,6 L12,6 Z",
    };

    // Keep the plotting rectangle fixed while switching views. Reserving the
    // larger legend footprint prevents the x-axis and bars from jumping when
    // one view has enough entries to wrap and the other does not.
    const legendData = showProductiveAverage ? [...stackNames, averageLegend] : stackNames;
    const legendItemCount = Math.max(categoryStacks.length, stateStacks.length + 1);
    const legendRows = Math.max(1, Math.ceil(legendItemCount / 6));
    const bottomPad = 40 + legendRows * 18;

    return {
      animation: false,
      grid: { left: 36, right: 12, top: 12, bottom: bottomPad },
      tooltip,
      legend: {
        show: true,
        bottom: 4,
        left: "center",
        width: "92%",
        data: legendData,
        textStyle: { color: CHROME.axisLabel, fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
        itemGap: 14,
      },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHROME.axisLine } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: CHROME.axisLabel, fontSize: 11, formatter: "{value}h" },
        splitLine: { lineStyle: { color: CHROME.gridLine } },
      },
      series: [
        ...stacks.map((stack, index) => ({
          name: stack.name,
          type: "bar" as const,
          stack: "day",
          data: stack.hours,
          itemStyle: {
            color: stack.color,
            // Only the topmost stack is rounded, so the bar reads as one shape.
            borderRadius: index === stacks.length - 1 ? [3, 3, 0, 0] : 0,
          },
          barMaxWidth: 36,
        })),
        ...(showProductiveAverage ? [{
          name: averageName,
          type: "line" as const,
          data: avgLine,
          symbol: "none",
          connectNulls: false,
          lineStyle: { color: ANNOTATION, width: 2, type: "dashed" },
          itemStyle: { color: ANNOTATION },
        }] : []),
      ],
    };
  }, [historySessions, range, classifier, labelMode, granularity, weekStart, stackBy, categories]);

  return <EChart option={option} height={254} />;
}

export function formatHoursTooltipValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "NA";
  const hours = Number(value);
  return Number.isFinite(hours) ? `${hours.toFixed(1)}h` : "NA";
}

export function formatHoursBucketRange(bucket: HoursBucket): string {
  const end = addDays(bucket.includedEnd, -1);
  return bucket.includedStart.getTime() === end.getTime()
    ? formatPeriodDate(bucket.includedStart)
    : `${formatPeriodDate(bucket.includedStart)}–${formatPeriodDate(end)}`;
}

function formatPeriodDate(date: Date): string {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** Uncategorized is supporting context, not a primary series. Suppress it
 *  until the selected range contains at least one hour in total. */
export function shouldShowUncategorized(hoursByPeriod: number[]): boolean {
  return hoursByPeriod.reduce((total, hours) => total + hours, 0) >= MIN_UNCATEGORIZED_SERIES_HOURS;
}
