// Long-range calendar: one cell per calendar month, years as rows and the
// twelve months as columns. The day-cell ActivityCalendar slices too thin past
// ~14 months; this stays a clean 12-wide grid from one year to forty, scrolling
// vertically once the years pile up. Same metric ramps and tooltip breakdown as
// the day calendar — it is that view zoomed out one level.

import { useMemo } from "react";

import type { Classifier } from "../lib/classify";
import { cleanProcessName, fmtDuration } from "../lib/format";
import type { Session } from "../lib/metrics";
import {
  metricSeconds,
  monthlyActivitySummaries,
  type ActivityMetric,
  type MonthlyActivitySummary,
} from "../lib/overview";
import type { Range } from "../lib/time";
import { useMeta } from "../state/meta";
import { ACTIVITY_METRIC_RAMPS, CHROME, TOOLTIP_STYLE } from "../lib/chartTheme";
import EChart, { type EChartsOption } from "./EChart";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CELL_HEIGHT = 26;
const CELL_WIDTH = 48;
const CHART_TOP = 28;
const CHART_BOTTOM = 16;
const GRID_LEFT = 44;
const GRID_RIGHT = 16;
// The chart fills its container width, so 12 columns are held near-square by
// capping the container instead — ECharts ignores grid.width beside
// left:"center", but honors plain left/right margins inside a capped box.
const MAX_WIDTH = GRID_LEFT + GRID_RIGHT + CELL_WIDTH * 12;
/** Beyond this many year-rows the grid scrolls instead of growing the card. */
const SCROLL_ROWS = 16;

export default function MonthCalendarChart({
  sessions,
  range,
  classifier,
  metric = "tracked",
}: {
  sessions: Session[];
  range: Range;
  classifier: Classifier;
  metric?: ActivityMetric;
}) {
  const { aliases } = useMeta();
  const years = useMemo(() => {
    const summaries = monthlyActivitySummaries(sessions, range, classifier);
    return [...new Set(summaries.map((month) => month.year))].sort((a, b) => a - b);
  }, [sessions, range, classifier]);

  const option = useMemo<EChartsOption>(() => {
    const summaries = monthlyActivitySummaries(sessions, range, classifier);
    const rowIndex = new Map(years.map((year, index) => [year, index]));
    const byPoint = new Map<string, MonthlyActivitySummary>();
    const data: [number, number, number][] = [];
    let maxHours = 0;
    for (const month of summaries) {
      const y = rowIndex.get(month.year);
      if (y === undefined) continue;
      const hours = metricSeconds(month, metric) / 3600;
      maxHours = Math.max(maxHours, hours);
      byPoint.set(`${month.month},${y}`, month);
      data.push([month.month, y, Math.round(hours * 100) / 100]);
    }

    return {
      animation: false,
      grid: {
        top: CHART_TOP,
        bottom: CHART_BOTTOM,
        left: GRID_LEFT,
        right: GRID_RIGHT,
        height: CELL_HEIGHT * years.length,
      },
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (p: { data: [number, number, number] }) => {
          const month = byPoint.get(`${p.data[0]},${p.data[1]}`);
          return month ? formatMonthCalendarTooltip(month, aliases) : "";
        },
      },
      xAxis: {
        type: "category",
        position: "top",
        data: MONTH_NAMES,
        axisLabel: { color: CHROME.axisLabel, fontSize: 10 },
        axisTick: { show: false },
        axisLine: { show: false },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: years.map(String),
        inverse: true, // earliest year on top
        axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
        axisTick: { show: false },
        axisLine: { show: false },
        splitArea: { show: false },
      },
      visualMap: {
        show: false,
        min: 0,
        max: Math.max(maxHours, 1),
        inRange: { color: ACTIVITY_METRIC_RAMPS[metric] },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: "#0f1115", borderWidth: 2, borderRadius: 2 },
        },
      ],
    };
  }, [sessions, range, classifier, metric, aliases, years]);

  const height = CELL_HEIGHT * years.length + CHART_TOP + CHART_BOTTOM;
  // Cap the width so 12 columns stay near-square in a full-width card, and
  // center it; scroll vertically once the years outgrow the card.
  const chart = (
    <div style={{ maxWidth: MAX_WIDTH, margin: "0 auto" }}>
      <EChart option={option} height={height} />
    </div>
  );
  return years.length > SCROLL_ROWS
    ? <div className="max-h-[476px] overflow-y-auto pr-1">{chart}</div>
    : chart;
}

export function formatMonthCalendarTooltip(
  month: MonthlyActivitySummary,
  aliases?: Record<string, string>,
): string {
  const productiveShare = month.trackedSeconds > 0
    ? Math.round((month.productiveSeconds / month.trackedSeconds) * 100)
    : 0;
  const topApp = month.topApp
    ? `<div style="color:${CHROME.axisLabel}">Top app: ${escapeHtml(cleanProcessName(month.topApp.process, aliases))} · ${fmtDuration(month.topApp.seconds)}</div>`
    : "";
  return [
    `<b>${FULL_MONTH_NAMES[month.month]} ${month.year}</b>`,
    `<div>Tracked: ${fmtDuration(month.trackedSeconds)}</div>`,
    `<div>Productive: ${fmtDuration(month.productiveSeconds)} (${productiveShare}%)</div>`,
    `<div>Neutral: ${fmtDuration(month.neutralSeconds)}</div>`,
    `<div>Unproductive: ${fmtDuration(month.unproductiveSeconds)}</div>`,
    `<div>Uncategorized: ${fmtDuration(month.uncategorizedSeconds)}</div>`,
    topApp,
  ].join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
