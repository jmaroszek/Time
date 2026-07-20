// Rhythm heatmap for multi-week ranges: weekday × hour cells shaded by
// average tracked (non-AFK) time per weekday occurrence. The blue ramp
// deliberately matches ActivityCalendar — both encode amount of tracked time
// without the productive/non-productive judgment; the tooltip carries the
// productivity breakdown instead.

import { useMemo } from "react";

import type { Classifier } from "../lib/classify";
import { cleanProcessName, fmtDuration } from "../lib/format";
import type { Session } from "../lib/metrics";
import { weekdayRhythmSummaries, type RhythmCell } from "../lib/overview";
import type { Range } from "../lib/time";
import { useMeta } from "../state/meta";
import { ACTIVITY_HEATMAP_RAMP, CHROME, TOOLTIP_STYLE } from "../lib/chartTheme";
import EChart, { type EChartsOption } from "./EChart";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function RhythmChart({
  sessions,
  range,
  classifier,
}: {
  sessions: Session[];
  range: Range;
  classifier: Classifier;
}) {
  const { aliases, weekStart, dayStartHour, dayEndHour } = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const { cells, weekdayCounts } = weekdayRhythmSummaries(
      sessions,
      range,
      classifier,
      dayStartHour,
      dayEndHour,
    );
    const weekdayRows = weekStart === "Monday" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    const rowIndex = new Map(weekdayRows.map((weekday, index) => [weekday, index]));
    const visibleHours: number[] = [];
    for (let h = dayStartHour; h < dayEndHour; h++) visibleHours.push(h);

    const cellByPoint = new Map<string, RhythmCell>();
    let maxMinutes = 0;
    const data: [number, number, number][] = [];
    for (const cell of cells) {
      const count = weekdayCounts[cell.weekday];
      const avgMinutes = count > 0 ? cell.trackedSeconds / count / 60 : 0;
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
          return cell ? formatRhythmTooltip(cell, weekdayCounts[cell.weekday], aliases) : "";
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
        max: Math.max(maxMinutes, 1),
        inRange: { color: ACTIVITY_HEATMAP_RAMP },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: "#0f1115", borderWidth: 1.5, borderRadius: 2 },
        },
      ],
    };
  }, [sessions, range, classifier, aliases, weekStart, dayStartHour, dayEndHour]);

  return <EChart option={option} height={260} />;
}

export function formatRhythmTooltip(
  cell: RhythmCell,
  weekdayCount: number,
  aliases?: Record<string, string>,
): string {
  const avg = (seconds: number) => fmtDuration(weekdayCount > 0 ? seconds / weekdayCount : 0);
  const occurrences = `${weekdayCount} ${FULL_DAY_NAMES[cell.weekday]}${weekdayCount === 1 ? "" : "s"}`;
  const topApp = cell.topApp
    ? `<div style="color:${CHROME.axisLabel}">Top app: ${escapeHtml(cleanProcessName(cell.topApp.process, aliases))} · ${fmtDuration(cell.topApp.seconds)} total</div>`
    : "";
  return [
    `<b>${FULL_DAY_NAMES[cell.weekday]} · ${compactHour(cell.hour)}–${compactHour(cell.hour + 1)}</b>`,
    `<div>Avg tracked: ${avg(cell.trackedSeconds)} <span style="color:${CHROME.axisLabel}">(over ${occurrences})</span></div>`,
    `<div>Productive: ${avg(cell.productiveSeconds)}</div>`,
    `<div>Neutral: ${avg(cell.neutralSeconds)}</div>`,
    `<div>Unproductive: ${avg(cell.unproductiveSeconds)}</div>`,
    `<div>Uncategorized: ${avg(cell.uncategorizedSeconds)}</div>`,
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
