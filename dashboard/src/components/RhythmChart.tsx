// Rhythm heatmap for multi-week ranges: weekday × hour cells shaded by
// average time per weekday occurrence.
//
// The ramp follows the metric, matching the convention in chartTheme: blue
// encodes amount of tracked time without the productive/non-productive
// judgment (same as ActivityCalendar), green encodes productive time (same as
// the productive bars). The tooltip stays scoped to the selected metric.

import { useMemo } from "react";

import { cleanProcessName, fmtDuration } from "../lib/format";
import {
  metricSeconds,
  metricTrackedShare,
  ACTIVITY_METRIC_WORDS,
  type ActivityMetric,
  type RhythmCell,
  type WeekdayRhythmSummary,
} from "../lib/overview";
import { useMeta } from "../state/meta";
import { ACTIVITY_METRIC_RAMPS, CHROME, TOOLTIP_STYLE } from "../lib/chartTheme";
import EChart, { type EChartsOption } from "./EChart";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function RhythmChart({
  summary,
  metric = "tracked",
}: {
  summary: WeekdayRhythmSummary;
  metric?: ActivityMetric;
}) {
  const { aliases, weekStart, dayStartHour, dayEndHour } = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const { cells, weekdayCounts } = summary;
    const weekdayRows = weekStart === "Monday" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    const rowIndex = new Map(weekdayRows.map((weekday, index) => [weekday, index]));
    const visibleHours: number[] = [];
    for (let h = dayStartHour; h < dayEndHour; h++) visibleHours.push(h);

    const cellByPoint = new Map<string, RhythmCell>();
    let maxMinutes = 0;
    const data: [number, number, number][] = [];
    for (const cell of cells) {
      const count = weekdayCounts[cell.weekday];
      const avgMinutes = count > 0 ? metricSeconds(cell, metric) / count / 60 : 0;
      maxMinutes = Math.max(maxMinutes, avgMinutes);
      const x = cell.hour - dayStartHour;
      const y = rowIndex.get(cell.weekday)!;
      cellByPoint.set(`${x},${y}`, cell);
      data.push([x, y, Math.round(avgMinutes * 10) / 10]);
    }

    return {
      animation: false,
      grid: { left: 44, right: 16, top: 8, bottom: 28 },
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (p: { data: [number, number, number] }) => {
          const cell = cellByPoint.get(`${p.data[0]},${p.data[1]}`);
          return cell
            ? formatRhythmTooltip(cell, weekdayCounts[cell.weekday], metric, aliases)
            : "";
        },
      },
      xAxis: {
        type: "category",
        data: visibleHours.map(compactHour),
        axisLabel: { color: CHROME.axisLabel, fontSize: 10 },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      yAxis: {
        type: "category",
        data: weekdayRows.map((weekday) => DAY_NAMES[weekday]),
        inverse: true, // first day of the week on top
        axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      visualMap: {
        show: false,
        min: 0,
        // Rescaled per metric — every state is a subset of tracked, so a shared
        // scale would render the narrower fields uniformly dim.
        max: Math.max(maxMinutes, 1),
        inRange: { color: ACTIVITY_METRIC_RAMPS[metric] },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: "#0f1115", borderWidth: 1.5, borderRadius: 2 },
        },
      ],
    };
  }, [summary, metric, aliases, weekStart, dayStartHour, dayEndHour]);

  return <EChart option={option} height={260} />;
}

export function formatRhythmTooltip(
  cell: RhythmCell,
  weekdayCount: number,
  metric: ActivityMetric = "tracked",
  aliases?: Record<string, string>,
): string {
  const avg = (seconds: number) => fmtDuration(weekdayCount > 0 ? seconds / weekdayCount : 0);
  const topApp = metric === "tracked" && cell.topApp
    ? `<div style="color:${CHROME.axisLabel}">Top app: ${escapeHtml(cleanProcessName(cell.topApp.process, aliases))} · ${fmtDuration(cell.topApp.seconds)} total</div>`
    : "";
  const share = metricTrackedShare(cell, metric);
  const word = ACTIVITY_METRIC_WORDS[metric];
  return [
    `<b>${FULL_DAY_NAMES[cell.weekday]} · ${compactHour(cell.hour)}–${compactHour(cell.hour + 1)}</b>`,
    `<div>Avg ${word}: ${avg(metricSeconds(cell, metric))}</div>`,
    share === null
      ? ""
      : `<div style="color:${CHROME.axisLabel}">${share}% of tracked time</div>`,
    topApp,
  ].join("");
}

function compactHour(hour: number): string {
  const normalized = hour % 24;
  return `${normalized % 12 || 12}${normalized < 12 ? "am" : "pm"}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
