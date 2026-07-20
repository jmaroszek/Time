// Adaptive activity hours: daily, weekly, or monthly productivity-state stacks
// plus a same-scale trailing average of productive time. `historySessions`
// includes the preceding periods needed to make the first visible average real.

import { useMemo } from "react";

import type { Classifier } from "../lib/classify";
import { rollingMean, type Session } from "../lib/metrics";
import {
  bucketActivityHours,
  dailyActivitySummaries,
  isCompleteHoursBucket,
  overviewHistoryStart,
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
  UNCATEGORIZED_BAR,
  UNPRODUCTIVE_BAR,
} from "../lib/chartTheme";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRODUCTIVE_AVERAGES = {
  daily: "7-day productive avg",
  weekly: "4-week productive avg",
  monthly: "3-month productive avg",
} as const;
const MIN_UNCATEGORIZED_SERIES_HOURS = 1;

export default function ProductiveHoursChart({
  historySessions,
  range,
  classifier,
  labelMode = "date",
  granularity = "daily",
  weekStart = "Sunday",
}: {
  historySessions: Session[];
  range: Range;
  classifier: Classifier;
  labelMode?: "weekday" | "date";
  granularity?: OverviewGranularity;
  weekStart?: WeekStart;
}) {
  const option = useMemo<EChartsOption>(() => {
    const round2 = (h: number) => Math.round(h * 100) / 100;
    let labels: string[];
    let prodBars: number[];
    let neutralBars: number[];
    let unproductiveBars: number[];
    let uncategorizedBars: number[];
    let avgLine: Array<number | null>;
    let buckets: HoursBucket[] = [];
    const averageName = PRODUCTIVE_AVERAGES[granularity];

    if (granularity === "daily") {
      const historyRange = {
        start: overviewHistoryStart(range, granularity, weekStart),
        end: range.end,
      };
      const historyDays = dailyActivitySummaries(historySessions, historyRange, classifier);
      const visibleDays = dailyActivitySummaries(historySessions, range, classifier);
      const offset = historyDays.length - visibleDays.length;
      labels = visibleDays.map((day) =>
        labelMode === "weekday" ? DAY_NAMES[day.date.getDay()] : fmtShortDate(day.date),
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
      const historyRange = {
        start: overviewHistoryStart(range, granularity, weekStart),
        end: range.end,
      };
      const historyDays = dailyActivitySummaries(historySessions, historyRange, classifier);
      const historyBuckets = bucketActivityHours(historyDays, historyRange, granularity, weekStart);
      const averageWindow = granularity === "weekly" ? 4 : 3;
      const averages = rollingMean(
        historyBuckets.map((bucket) => bucket.productiveSeconds / 3600),
        averageWindow,
      );
      const averageByKey = new Map(historyBuckets.map((bucket, index) => [bucket.key, round2(averages[index])]));
      labels = buckets.map((bucket) =>
        granularity === "weekly"
          ? fmtShortDate(bucket.periodStart)
          : `${MONTH_NAMES[bucket.periodStart.getMonth()]} '${String(bucket.periodStart.getFullYear()).slice(-2)}`,
      );
      prodBars = buckets.map((bucket) => round2(bucket.productiveSeconds / 3600));
      neutralBars = buckets.map((bucket) => round2(bucket.neutralSeconds / 3600));
      unproductiveBars = buckets.map((bucket) => round2(bucket.unproductiveSeconds / 3600));
      uncategorizedBars = buckets.map((bucket) => round2(bucket.uncategorizedSeconds / 3600));
      avgLine = buckets.map((bucket) =>
        isCompleteHoursBucket(bucket, granularity) ? (averageByKey.get(bucket.key) ?? null) : null,
      );
    }

    const hasUncategorized = shouldShowUncategorized(uncategorizedBars);
    const stackNames = ["Productive", "Neutral", "Unproductive", ...(hasUncategorized ? ["Uncategorized"] : [])];
    const tooltip = {
      trigger: "axis" as const,
      ...TOOLTIP_STYLE,
      formatter: (params: Array<{ axisValueLabel: string; dataIndex: number; marker: string; seriesName: string; value: number }>) => {
        if (!params.length) return "";
        const byName = new Map(params.map((p) => [p.seriesName, p]));
        const rows = [averageName, ...stackNames]
          .map((name) => byName.get(name))
          .filter((p): p is NonNullable<typeof p> => p !== undefined)
          .map((p) => `${p.marker}${p.seriesName}: <b>${Number(p.value).toFixed(1)}h</b>`);
        if (granularity === "daily") {
          return [params[0].axisValueLabel, ...rows].join("<br/>");
        }
        const bucket = buckets[params[0].dataIndex];
        const partial = isCompleteHoursBucket(bucket, granularity)
          ? ""
          : ` · partial ${granularity === "weekly" ? "week" : "month"}`;
        return [`<b>${formatHoursBucketRange(bucket)}${partial}</b>`, ...rows].join("<br/>");
      },
    };

    const averageLegend = {
      name: averageName,
      icon: "path://M0,4 L4,4 L4,6 L0,6 Z M6,4 L10,4 L10,6 L6,6 Z M12,4 L16,4 L16,6 L12,6 Z",
    };

    return {
      animation: false,
      grid: { left: 36, right: 12, top: 12, bottom: hasUncategorized ? 76 : 58 },
      tooltip,
      legend: {
        show: true,
        bottom: 0,
        left: "center",
        width: "92%",
        data: [...stackNames, averageLegend],
        textStyle: { color: CHROME.axisLabel, fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
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
        {
          name: "Productive",
          type: "bar",
          stack: "day",
          data: prodBars,
          itemStyle: { color: PRODUCTIVE_BAR },
          barMaxWidth: 36,
        },
        {
          name: "Neutral",
          type: "bar",
          stack: "day",
          data: neutralBars,
          itemStyle: { color: NEUTRAL_BAR },
          barMaxWidth: 36,
        },
        {
          name: "Unproductive",
          type: "bar",
          stack: "day",
          data: unproductiveBars,
          itemStyle: {
            color: UNPRODUCTIVE_BAR,
            borderRadius: hasUncategorized ? 0 : [3, 3, 0, 0],
          },
          barMaxWidth: 36,
        },
        ...(hasUncategorized
          ? [{
              name: "Uncategorized",
              type: "bar" as const,
              stack: "day",
              data: uncategorizedBars,
              itemStyle: { color: UNCATEGORIZED_BAR, borderRadius: [3, 3, 0, 0] },
              barMaxWidth: 36,
            }]
          : []),
        {
          name: averageName,
          type: "line",
          data: avgLine,
          symbol: "none",
          connectNulls: false,
          lineStyle: { color: ANNOTATION, width: 2, type: "dashed" },
          itemStyle: { color: ANNOTATION },
        },
      ],
    };
  }, [historySessions, range, classifier, labelMode, granularity, weekStart]);

  return <EChart option={option} height={254} />;
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
