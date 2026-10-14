// Adaptive activity hours: daily, weekly, or monthly productivity-state stacks
// plus a same-scale trailing average of productive time. `historyDays` includes
// the preceding periods needed to make the first visible average real.

import { useEffect, useMemo, useRef, useState } from "react";

import type { Category } from "../lib/classify";
import type { InsightsMemberTotal } from "../lib/insights";
import { rollingMeanObserved } from "../lib/metrics";
import {
  bucketActivityHours,
  isCompleteHoursBucket,
  overviewHistoryStart,
  UNCATEGORIZED_LABEL,
  type ActivityStack,
  type ActivityTotals,
  type DailyActivitySummary,
  type HoursBucket,
  type OverviewGranularity,
} from "../lib/overview";
import { addDays, calendarDays, type Range } from "../lib/time";
import type { WeekStart } from "../lib/time";
import { DAY_NAMES, FULL_DAY_NAMES, MONTH_NAMES_SHORT, fmtShortDate } from "../lib/format";
import EChart, { type EChartsOption } from "./EChart";
import type { ThemeName } from "../lib/theme";
import { useMeta } from "../state/meta";
import {
  annotation,
  CHART_FONT_FAMILY,
  CHART_LABEL_FONT,
  CHART_LABEL_SIZE,
  chartChrome,
  STACKED_BAR_LEGEND_GEOMETRY,
  stackedBarLegend,
  tooltipStyle,
  uncategorizedMark,
  uncategorizedBar,
} from "../lib/chartTheme";
import { tooltipRow } from "../lib/chartTooltip";
import { totalBarColor } from "../lib/palettes";

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
  theme: ThemeName,
): CategorySeries[] {
  const ordered: { name: string; color: string }[] = [
    ...categories.filter((category) => !category.isIgnored),
    { name: UNCATEGORIZED_LABEL, color: uncategorizedMark(theme) },
  ];
  const out: Array<CategorySeries & { configuredIndex: number; totalSeconds: number }> = [];
  const uncategorizedTotal = buckets.reduce(
    (total, bucket) => total + (bucket.categorySeconds.get(UNCATEGORIZED_LABEL) ?? 0),
    0,
  );
  const categorizedTotal = buckets.reduce(
    (total, bucket) => total + [...bucket.categorySeconds.entries()]
      .filter(([name]) => name !== UNCATEGORIZED_LABEL)
      .reduce((bucketTotal, [, seconds]) => bucketTotal + seconds, 0),
    0,
  );
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
          || (uncategorizedTotal > 0 && categorizedTotal === 0)
        : totalSeconds > 0;
    if (meetsThreshold) out.push({ name, color, hours, configuredIndex, totalSeconds });
  }
  return out
    .sort((a, b) => b.totalSeconds - a.totalSeconds || a.configuredIndex - b.configuredIndex)
    .map(({ name, color, hours }) => ({ name, color, hours }));
}

/** Members drawn as stacks of their own before the rest fold into one. Past
 *  this the legend outgrows the card and the colours stop being tellable apart:
 *  six is what the palette's eight hue identities hold with margin. */
export const MEMBER_SERIES_LIMIT = 6;
export const OTHER_MEMBERS_LABEL = "Other";

/**
 * App and website stacks for a narrowed view, heaviest at the base.
 *
 * Colours are handed out in rank order rather than kept per app: a narrowed
 * view has its own handful of members, and order is the one assignment that
 * cannot give two of them the same colour. The tail folds into "Other" in the
 * gray Uncategorized uses — it is a remainder, not a member — except when it
 * would be a single member, which is then simply shown.
 */
export function memberSeries(
  buckets: { memberSeconds?: Map<string, number> }[],
  members: { key: string; name: string; kind: "app" | "website" }[],
  swatches: readonly string[],
  otherColor: string,
): CategorySeries[] {
  const round2 = (hours: number) => Math.round(hours * 100) / 100;
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const [key, seconds] of bucket.memberSeconds ?? []) {
      totals.set(key, (totals.get(key) ?? 0) + seconds);
    }
  }
  const ranked = members
    .filter((member) => (totals.get(member.key) ?? 0) > 0)
    .sort((left, right) =>
      (totals.get(right.key) ?? 0) - (totals.get(left.key) ?? 0)
      || left.name.localeCompare(right.name));
  const shown = ranked.length > MEMBER_SERIES_LIMIT + 1
    ? ranked.slice(0, MEMBER_SERIES_LIMIT)
    : ranked;
  const shownKeys = new Set(shown.map((member) => member.key));
  // Series are keyed by name, so an app and a website that share one — an
  // alias can make them — would merge into a single legend entry.
  const names = new Set<string>();
  const series: CategorySeries[] = shown.map((member, index) => {
    const name = names.has(member.name) ? `${member.name} (${member.kind})` : member.name;
    names.add(name);
    return {
      name,
      color: swatches[index % swatches.length],
      hours: buckets.map((bucket) => round2((bucket.memberSeconds?.get(member.key) ?? 0) / 3600)),
    };
  });
  if (shown.length < ranked.length) {
    series.push({
      name: OTHER_MEMBERS_LABEL,
      color: otherColor,
      hours: buckets.map((bucket) => {
        let seconds = 0;
        for (const [key, memberSeconds] of bucket.memberSeconds ?? []) {
          if (!shownKeys.has(key)) seconds += memberSeconds;
        }
        return round2(seconds / 3600);
      }),
    });
  }
  return series;
}

/**
 * The stacks that actually draw something in the visible range.
 *
 * A productivity state (or category) with no time on screen contributes no bar
 * segment, so its legend entry is a key to a colour the reader cannot find —
 * "Unproductive" sitting in the legend of a week that had none reads as a
 * measurement rather than an absence. The test is the DISPLAYED hours, already
 * rounded to hundredths exactly as the bars are, so a handful of stray seconds
 * that render nothing don't keep an entry alive either.
 */
export function representedStacks<T extends { hours: number[] }>(stacks: T[]): T[] {
  return stacks.filter((stack) => stack.hours.some((hours) => hours > 0));
}

const PRODUCTIVE_AVERAGES = {
  daily: "7-day productive avg",
  weekly: "4-week productive avg",
  monthly: "3-month productive avg",
  yearly: "3-year productive avg",
} as const;
const TRACKED_AVERAGES = {
  daily: "7-day avg",
  weekly: "4-week avg",
  monthly: "3-month avg",
  yearly: "3-year avg",
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
  return Math.round(value * 100) / 100;
}

// Legend geometry, derived from the `legend` option the chart actually sets so
// the row estimate cannot disagree with what ECharts lays out. Everything here
// reads from STACKED_BAR_LEGEND_GEOMETRY or CHART_LABEL_FONT rather than
// restating a number: both sides then resolve identically, including a
// missing-font fallback.
const LEGEND_ITEM_WIDTH = STACKED_BAR_LEGEND_GEOMETRY.itemWidth;
const LEGEND_ICON_GAP = 5; // fixed icon-to-text spacing ECharts inserts, not an option
const LEGEND_ITEM_GAP = STACKED_BAR_LEGEND_GEOMETRY.itemGap;
/**
 * ECharts' per-row pitch for a wrapped horizontal legend: the text box, whose
 * height is the font size, plus the `itemGap` it reuses as the row gap.
 *
 * Measured against a real render to confirm the rule rather than assume it — at
 * `fontSize: 11` the pitch is exactly 25, at `11.5` exactly 25.5. Reserve too
 * little and a wrapped legend creeps upward into the x-axis labels, and the
 * shortfall compounds with each row.
 */
const LEGEND_ROW_H = CHART_LABEL_SIZE + LEGEND_ITEM_GAP;
// Trim a little off the usable width so we round toward wrapping: an
// unpredicted extra row collides with the x-axis, while a spare predicted row
// only pads the (invisible) top margin.
const LEGEND_WIDTH_SAFETY = 16;
const LEGEND_ITEMS_PER_ROW_FALLBACK = 6; // used until the container is measured

/** Usable legend width for a chart of `chartWidth` px, matching the `legend`
 *  option below (`width: "92%"`) less a safety margin. ECharts wraps on the
 *  declared width itself — its 5px padding does not eat into the row. */
export function legendContentWidth(chartWidth: number): number {
  return chartWidth * 0.92 - LEGEND_WIDTH_SAFETY;
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
  measure: (text: string) => number = (text) => measureTextWidth(text, CHART_LABEL_FONT),
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
  members = null,
  averageMeasure = "productive",
}: {
  historyDays: DailyActivitySummary[];
  range: Range;
  labelMode?: "weekday" | "date";
  granularity?: OverviewGranularity;
  weekStart?: WeekStart;
  stackBy?: ActivityStack;
  categories?: Category[];
  /** Names for the member stacks; see `memberSeries`. */
  members?: InsightsMemberTotal[] | null;
  /** What the dashed line averages. Productive time is the page's own
   *  question; a single app's is how much it was used, since its productivity
   *  is just its category — and for an unproductive one, a flat zero. */
  averageMeasure?: "productive" | "tracked";
}) {
  const { palette, theme } = useMeta();
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
    // Whichever bucket run is on screen, for the category and member stacks.
    let visible: { categorySeconds: Map<string, number>; memberSeconds?: Map<string, number> }[] = [];
    const averageName = (averageMeasure === "tracked" ? TRACKED_AVERAGES : PRODUCTIVE_AVERAGES)[granularity];
    const averagedHours = (totals: ActivityTotals) =>
      (averageMeasure === "tracked" ? totals.trackedSeconds : totals.productiveSeconds) / 3600;
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
        `${labelMode === "weekday" ? FULL_DAY_NAMES[day.date.getDay()] : fmtShortDate(day.date)}${
          day.observation === "partial" ? " · partial day" : ""
        }`,
      );
      prodBars = visibleDays.map((day) => round2(day.productiveSeconds / 3600));
      neutralBars = visibleDays.map((day) => round2(day.neutralSeconds / 3600));
      unproductiveBars = visibleDays.map((day) => round2(day.unproductiveSeconds / 3600));
      uncategorizedBars = visibleDays.map((day) => round2(day.uncategorizedSeconds / 3600));
      avgLine = rollingMeanObserved(
        historyDays.map((day) =>
          day.observation === "complete" ? averagedHours(day) : null
        ),
        7,
      )
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
      const averages = rollingMeanObserved(
        historyBuckets.map((bucket) =>
          bucket.observation === "complete" ? averagedHours(bucket) : null
        ),
        averageWindow,
      );
      const averageByKey = new Map(
        historyBuckets.map((bucket, index) => [bucket.key, visibleAverageHours(averages[index])]),
      );
      labels = buckets.map((bucket) => {
        if (granularity === "weekly") return fmtShortDate(bucket.periodStart);
        if (granularity === "yearly") return String(bucket.periodStart.getFullYear());
        return `${MONTH_NAMES_SHORT[bucket.periodStart.getMonth()]} '${String(bucket.periodStart.getFullYear()).slice(-2)}`;
      });
      tooltipHeaders = buckets.map((bucket) => {
        const period = granularity === "weekly" ? "week" : granularity === "yearly" ? "year" : "month";
        const partial = bucket.observation === "partial" ? ` · partial ${period}` : "";
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

    const hasUncategorized = shouldShowUncategorized(
      uncategorizedBars,
      prodBars.map((hours, index) => hours + neutralBars[index] + unproductiveBars[index]),
    );
    const stateStacks: CategorySeries[] = representedStacks([
      { name: "Productive", color: palette.productive, hours: prodBars },
      { name: "Neutral", color: palette.neutral, hours: neutralBars },
      { name: "Unproductive", color: palette.unproductive, hours: unproductiveBars },
      ...(hasUncategorized
        ? [{ name: "Uncategorized", color: uncategorizedBar(theme), hours: uncategorizedBars }]
        : []),
    ]);
    const totalStacks: CategorySeries[] = [{
      name: TOTAL_STACK_NAME,
      color: totalBarColor(theme),
      hours: prodBars.map((hours, index) =>
        round2(hours + neutralBars[index] + unproductiveBars[index] + uncategorizedBars[index])),
    }];
    return { labels, avgLine, tooltipHeaders, visible, averageName, stateStacks, totalStacks };
  }, [historyDays, range, labelMode, granularity, weekStart, palette, theme, averageMeasure]);

  const option = useMemo<EChartsOption>(() => {
    const chrome = chartChrome(theme);
    const { labels, avgLine, tooltipHeaders, visible, averageName, stateStacks, totalStacks } = agg;
    const categoryStacks = representedStacks(categorySeries(visible, categories, theme));
    const memberStacks = stackBy === "member" && members
      ? representedStacks(memberSeries(
          visible,
          members,
          palette.swatches.slice(0, 8),
          uncategorizedBar(theme),
        ))
      : [];
    const stacks = stackBy === "category"
      ? categoryStacks
      : stackBy === "member"
        ? memberStacks
        : stackBy === "total"
          ? totalStacks
          : stateStacks;
    const stackNames = stacks.map((stack) => stack.name);
    // The category view has always gone without the line. The member view
    // only exists narrowed, where the line averages the subject's own time,
    // and that is the comparison its bars are there to make.
    const showProductiveAverage = stackBy !== "category";
    const tooltip = {
      trigger: "axis" as const,
      ...tooltipStyle(theme),
      formatter: (params: Array<{ axisValueLabel: string; dataIndex: number; marker: string; seriesName: string; value: unknown }>) => {
        if (!params.length) return "";
        const byName = new Map(params.map((p) => [p.seriesName, p]));
        const rows = [...(showProductiveAverage ? [averageName] : []), ...stackNames]
          .map((name) => byName.get(name))
          .filter((p): p is NonNullable<typeof p> => p !== undefined)
          .flatMap((p) => formatHoursTooltipRow(p, averageName));
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
      stackBy === "member" || stackBy === "total"
        ? legendDataLabels(legendData)
        : showProductiveAverage ? stateLegendLabels : categoryLegendLabels,
      legendWidth,
    );
    // The member and total views have no control to toggle away from, so they
    // have no other view's legend to keep the plot the same height as.
    const maxRows = stackBy === "member" || stackBy === "total" ? thisRows : Math.max(
      estimateLegendRows(stateLegendLabels, legendWidth),
      estimateLegendRows(categoryLegendLabels, legendWidth),
    );
    const bottomPad = AXIS_BAND + thisRows * LEGEND_ROW_H;
    const topPad = GRID_TOP + (maxRows - thisRows) * LEGEND_ROW_H;

    return {
      animation: false,
      textStyle: { fontFamily: CHART_FONT_FAMILY },
      grid: { left: 36, right: 12, top: topPad, bottom: bottomPad },
      tooltip,
      legend: stackedBarLegend(chrome, legendData),
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: chrome.axisLabel, fontSize: CHART_LABEL_SIZE },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: chrome.axisLine } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chrome.axisLabel, fontSize: CHART_LABEL_SIZE, formatter: "{value}h" },
        splitLine: { lineStyle: { color: chrome.gridLine } },
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
          lineStyle: { color: annotation(theme), width: 2, type: "dashed" },
          itemStyle: { color: annotation(theme) },
        }] : []),
      ],
    };
  }, [agg, stackBy, categories, members, chartWidth, theme, palette]);

  return (
    <div ref={wrapRef}>
      <EChart
        option={option}
        height={254}
        accessibleDescription={`Stacked ${granularity} activity hours for the selected ${
          calendarDays(range)
        }-day period, broken down by ${STACK_WORDS[stackBy]} with a ${averageMeasure === "tracked" ? "tracked" : "productive"}-time rolling average.`}
      />
    </div>
  );
}

/** How each stack view is named in the charts' accessible descriptions. */
export const STACK_WORDS: Record<ActivityStack, string> = {
  state: "productivity state",
  category: "category",
  member: "app and website",
  total: "total time",
};

/** The one series of the "total" view. */
export const TOTAL_STACK_NAME = "Time";

function legendDataLabels(data: Array<string | { name: string }>): string[] {
  return data.map((entry) => (typeof entry === "string" ? entry : entry.name));
}

export function formatHoursTooltipValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? `${hours.toFixed(1)}h` : null;
}

/**
 * One tooltip line for a state/category stack segment or the average line.
 * Zero-hour stack segments (a productivity state or category with no time in
 * this bucket) are noise in the tooltip and are dropped; the average line is
 * a real measurement even when it's zero, so it's always shown.
 */
export function formatHoursTooltipRow(
  p: { marker: string; seriesName: string; value: unknown },
  averageName: string,
): string[] {
  const value = formatHoursTooltipValue(p.value);
  // Stack values are rounded to hundredths, one digit finer than the tooltip's
  // toFixed(1) display, so compare against the DISPLAYED zero ("0.0h") rather
  // than the raw number — a value like 0.03 must still show, not just >0.
  if (value === null || (p.seriesName !== averageName && value === "0.0h")) return [];
  return [tooltipRow(p.marker, p.seriesName, `<b>${value}</b>`)];
}

export function formatHoursBucketRange(bucket: HoursBucket): string {
  const end = addDays(bucket.includedEnd, -1);
  return bucket.includedStart.getTime() === end.getTime()
    ? formatPeriodDate(bucket.includedStart)
    : `${formatPeriodDate(bucket.includedStart)}–${formatPeriodDate(end)}`;
}

function formatPeriodDate(date: Date): string {
  return `${MONTH_NAMES_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** Uncategorized is supporting context, not a primary series. Suppress it
 *  until the selected range contains at least one hour in total. */
export function shouldShowUncategorized(
  hoursByPeriod: number[],
  otherHoursByPeriod: number[] = [],
): boolean {
  const uncategorizedHours = hoursByPeriod.reduce((total, hours) => total + hours, 0);
  const otherHours = otherHoursByPeriod.reduce((total, hours) => total + hours, 0);
  return uncategorizedHours >= MIN_UNCATEGORIZED_SERIES_HOURS
    || (uncategorizedHours > 0 && otherHours === 0);
}
