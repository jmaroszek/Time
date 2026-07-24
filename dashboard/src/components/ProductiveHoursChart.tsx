// Adaptive activity hours: daily, weekly, or monthly productivity-state stacks
// plus a same-scale trailing average of productive time. `historyDays` includes
// the preceding periods needed to make the first visible average real.

import { useEffect, useMemo, useRef, useState } from "react";

import type { Category } from "../lib/classify";
import { rollingMean } from "../lib/metrics";
import {
  bucketActivityHours,
  isCompleteHoursBucket,
  overviewHistoryStart,
  UNCATEGORIZED_LABEL,
  type ActivityStack,
  type DailyActivitySummary,
  type HoursBucket,
  type OverviewGranularity,
} from "../lib/overview";
import { addDays, type Range } from "../lib/time";
import type { WeekStart } from "../lib/time";
import { fmtShortDate } from "../lib/format";
import EChart, { type EChartsOption } from "./EChart";
import { useMeta } from "../state/meta";
import {
  ANNOTATION,
  CHROME,
  TOOLTIP_STYLE,
  UNCATEGORIZED,
  UNCATEGORIZED_BAR,
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
    // Uncategorized is supporting context, not a primary series: hold it back
    // until there's at least an hour of it, matching the state view's gate.
    // Real categories show whenever they have any time in range.
    const meetsThreshold =
      name === UNCATEGORIZED_LABEL
        ? totalSeconds >= MIN_UNCATEGORIZED_SERIES_HOURS * 3600
        : totalSeconds > 0;
    if (meetsThreshold) out.push({ name, color, hours, configuredIndex, totalSeconds });
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

/**
 * Empty history buckets before tracking began are zero-filled for aligned bars,
 * but a zero there is not evidence of a measured productivity average.
 */
export function visibleAverageHours(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? rounded : null;
}

// Legend geometry, mirrored from the `legend` option below so the row estimate
// matches what ECharts actually lays out.
const LEGEND_FONT = "11px sans-serif";
const LEGEND_ITEM_WIDTH = 14; // legend.itemWidth
const LEGEND_ICON_GAP = 5; // fixed icon-to-text spacing ECharts inserts
const LEGEND_ITEM_GAP = 14; // legend.itemGap between entries
const LEGEND_H_PADDING = 10; // legend.padding default (5px) on each side
// Trim a hair more off the usable width so we round toward wrapping: an
// unpredicted extra row collides with the x-axis, while a spare predicted row
// only pads the (invisible) top margin.
const LEGEND_WIDTH_SAFETY = 6;
const LEGEND_ITEMS_PER_ROW_FALLBACK = 6; // used until the container is measured

/** Usable legend width for a chart of `chartWidth` px, matching the `legend`
 *  option below (`width: "92%"`) minus ECharts' padding and a safety margin. */
export function legendContentWidth(chartWidth: number): number {
  return chartWidth * 0.92 - LEGEND_H_PADDING - LEGEND_WIDTH_SAFETY;
}

let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidth(text: string, font: string): number {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return text.length * 6.5; // crude fallback if 2d context is unavailable
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Rows ECharts will wrap a horizontal legend into, by greedily packing each
 * entry's measured pixel width into `availableWidth`. Before the container has
 * been measured (`availableWidth <= 0`), fall back to a count-based guess so the
 * first paint is still reasonable.
 */
export function estimateLegendRows(
  labels: string[],
  availableWidth: number,
  measure: (text: string) => number = (text) => measureTextWidth(text, LEGEND_FONT),
): number {
  if (labels.length === 0) return 1;
  if (availableWidth <= 0) {
    return Math.max(1, Math.ceil(labels.length / LEGEND_ITEMS_PER_ROW_FALLBACK));
  }
  const itemWidth = (label: string) =>
    LEGEND_ITEM_WIDTH + LEGEND_ICON_GAP + measure(label);
  let rows = 1;
  let rowWidth = 0;
  for (const label of labels) {
    const w = itemWidth(label);
    if (rowWidth === 0) {
      rowWidth = w; // first entry on a row always fits, even if it overflows alone
    } else if (rowWidth + LEGEND_ITEM_GAP + w <= availableWidth) {
      rowWidth += LEGEND_ITEM_GAP + w;
    } else {
      rows += 1;
      rowWidth = w;
    }
  }
  return rows;
}

export default function ProductiveHoursChart({
  historyDays,
  range,
  labelMode = "date",
  granularity = "daily",
  weekStart = "Sunday",
  stackBy = "state",
  categories = [],
}: {
  historyDays: DailyActivitySummary[];
  range: Range;
  labelMode?: "weekday" | "date";
  granularity?: OverviewGranularity;
  weekStart?: WeekStart;
  stackBy?: ActivityStack;
  categories?: Category[];
}) {
  const { palette } = useMeta();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setChartWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Session-scale work is completed by the Insights worker. This memo only
  // folds the bounded daily summaries into display buckets.
  const agg = useMemo(() => {
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
    const visibleDays = historyDays.filter(
      (day) => day.date >= range.start && day.date < range.end,
    );

    if (granularity === "daily") {
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
        .map(visibleAverageHours);
    } else {
      buckets = bucketActivityHours(visibleDays, range, granularity, weekStart);
      visible = buckets;
      const historyRange = {
        start: overviewHistoryStart(range, granularity, weekStart),
        end: range.end,
      };
      const historyBuckets = bucketActivityHours(historyDays, historyRange, granularity, weekStart);
      const averageWindow = AVERAGE_WINDOWS[granularity];
      const averages = rollingMean(
        historyBuckets.map((bucket) => bucket.productiveSeconds / 3600),
        averageWindow,
      );
      const averageByKey = new Map(
        historyBuckets.map((bucket, index) => [bucket.key, visibleAverageHours(averages[index])]),
      );
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
      { name: "Productive", color: palette.productive, hours: prodBars },
      { name: "Neutral", color: palette.neutral, hours: neutralBars },
      { name: "Unproductive", color: palette.unproductive, hours: unproductiveBars },
      ...(hasUncategorized
        ? [{ name: "Uncategorized", color: UNCATEGORIZED_BAR, hours: uncategorizedBars }]
        : []),
    ];
    return { labels, avgLine, tooltipHeaders, visible, averageName, stateStacks };
  }, [historyDays, range, labelMode, granularity, weekStart, palette]);

  const option = useMemo<EChartsOption>(() => {
    const { labels, avgLine, tooltipHeaders, visible, averageName, stateStacks } = agg;
    const categoryStacks = categorySeries(visible, categories);
    const stacks = stackBy === "category" ? categoryStacks : stateStacks;
    const stackNames = stacks.map((stack) => stack.name);
    const showProductiveAverage = stackBy === "state";
    const tooltip = {
      trigger: "axis" as const,
      ...TOOLTIP_STYLE,
      formatter: (params: Array<{ axisValueLabel: string; dataIndex: number; marker: string; seriesName: string; value: unknown }>) => {
        if (!params.length) return "";
        const byName = new Map(params.map((p) => [p.seriesName, p]));
        const rows = [...(showProductiveAverage ? [averageName] : []), ...stackNames]
          .map((name) => byName.get(name))
          .filter((p): p is NonNullable<typeof p> => p !== undefined)
          .flatMap((p) => {
            const value = formatHoursTooltipValue(p.value);
            return value === null ? [] : [`${p.marker}${p.seriesName}: <b>${value}</b>`];
          });
        return [`<b>${tooltipHeaders[params[0].dataIndex]}</b>`, ...rows].join("<br/>");
      },
    };

    const averageLegend = {
      name: averageName,
      icon: "path://M0,4 L4,4 L4,6 L0,6 Z M6,4 L10,4 L10,6 L6,6 Z M12,4 L16,4 L16,6 L12,6 Z",
    };

    // Keep the plotting rectangle the same HEIGHT across views so bars — which
    // share a total, hence a y-scale — never change length. Rather than reserve
    // the worst-case legend at the bottom in every view (which strands an empty
    // row next to a one-row legend), reserve exactly what THIS view needs at the
    // bottom and park the leftover worst-case slack on top. Same grid height,
    // but the freed space goes where it doesn't show.
    // ECharts' real per-row pitch for an 11px legend. This must match what it
    // actually draws: reserve too little and a wrapped legend creeps upward into
    // the bars, and the shortfall compounds with each row (a two-row legend
    // overshoots by 2×). Matching it keeps the gap above the top row constant
    // whether the legend is one row or two.
    const LEGEND_ROW_H = 22;
    const AXIS_BAND = 40; // x-axis labels + baseline gap below the plot
    const GRID_TOP = 12;
    const legendData = showProductiveAverage ? [...stackNames, averageLegend] : stackNames;
    // Estimate wrapping from the real legend width (92% of the chart, matching
    // the `legend.width` below). Rows are computed for BOTH views so the grid
    // can reserve the worst case as height while each view pads only what it
    // needs at the bottom.
    const legendWidth = legendContentWidth(chartWidth);
    const stateLegendLabels = [...stateStacks.map((s) => s.name), averageName];
    const categoryLegendLabels = categoryStacks.map((s) => s.name);
    const thisRows = estimateLegendRows(
      showProductiveAverage ? stateLegendLabels : categoryLegendLabels,
      legendWidth,
    );
    const maxRows = Math.max(
      estimateLegendRows(stateLegendLabels, legendWidth),
      estimateLegendRows(categoryLegendLabels, legendWidth),
    );
    const bottomPad = AXIS_BAND + thisRows * LEGEND_ROW_H;
    const topPad = GRID_TOP + (maxRows - thisRows) * LEGEND_ROW_H;

    return {
      animation: false,
      grid: { left: 36, right: 12, top: topPad, bottom: bottomPad },
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
  }, [agg, stackBy, categories, chartWidth]);

  return (
    <div ref={wrapRef}>
      <EChart option={option} height={254} />
    </div>
  );
}

export function formatHoursTooltipValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? `${hours.toFixed(1)}h` : null;
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
