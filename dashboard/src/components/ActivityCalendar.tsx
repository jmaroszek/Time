import { useMemo } from "react";

import { cleanProcessName, fmtDuration } from "../lib/format";
import { dailyActivitySummaries, type DailyActivitySummary } from "../lib/overview";
import { addDays, dayKey, startOfWeek, type Range } from "../lib/time";
import type { Classifier } from "../lib/classify";
import type { Session } from "../lib/metrics";
import { useMeta } from "../state/meta";
import { ACTIVITY_HEATMAP_RAMP, CHROME, TOOLTIP_STYLE } from "../lib/chartTheme";
import EChart, { type EChartsOption } from "./EChart";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function ActivityCalendar({
  sessions,
  range,
  classifier,
}: {
  sessions: Session[];
  range: Range;
  classifier: Classifier;
}) {
  const { aliases, weekStart } = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const summaries = dailyActivitySummaries(sessions, range, classifier);
    const byKey = new Map(summaries.map((day) => [day.key, day]));
    const maxHours = Math.max(...summaries.map((day) => day.trackedSeconds / 3600), 1);
    const lastDay = addDays(range.end, -1);
    // "auto" stretches columns to fill the card, which turns a short range into
    // a row of wide bars instead of a calendar. Pin the cell width until there
    // are enough weeks to fill the width honestly, and center the small grid.
    const weekColumns = Math.ceil(
      (range.end.getTime() - startOfWeek(range.start, weekStart).getTime()) / (7 * 86_400_000),
    );
    const isNarrow = weekColumns <= 40;

    return {
      animation: false,
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (params: { data: [string, number] }) => {
          const day = byKey.get(params.data[0]);
          return day ? formatActivityCalendarTooltip(day, aliases) : "";
        },
      },
      visualMap: {
        show: false,
        min: 0,
        max: maxHours,
        inRange: { color: ACTIVITY_HEATMAP_RAMP },
      },
      calendar: {
        top: 28,
        left: isNarrow ? "center" : 48,
        right: 12,
        bottom: 12,
        range: [dayKey(range.start), dayKey(lastDay)],
        cellSize: isNarrow ? [22, 18] : ["auto", 18],
        splitLine: { show: false },
        itemStyle: {
          color: ACTIVITY_HEATMAP_RAMP[0],
          borderColor: CHROME.gridLine,
          borderWidth: 2,
        },
        dayLabel: {
          firstDay: weekStart === "Monday" ? 1 : 0,
          nameMap: DAY_NAMES,
          color: CHROME.axisLabel,
          fontSize: 10,
          margin: 8,
        },
        monthLabel: {
          color: CHROME.axisLabel,
          fontSize: 10,
          margin: 8,
        },
        yearLabel: { show: false },
      },
      series: [
        {
          type: "heatmap",
          coordinateSystem: "calendar",
          data: summaries.map((day) => [day.key, Math.round((day.trackedSeconds / 3600) * 100) / 100]),
        },
      ],
    };
  }, [sessions, range, classifier, aliases, weekStart]);

  return <EChart option={option} height={220} />;
}

export function formatActivityCalendarTooltip(
  day: DailyActivitySummary,
  aliases?: Record<string, string>,
): string {
  const date = `${FULL_DAY_NAMES[day.date.getDay()]}, ${MONTH_NAMES[day.date.getMonth()]} ${day.date.getDate()}, ${day.date.getFullYear()}`;
  const productiveShare = day.trackedSeconds > 0
    ? Math.round((day.productiveSeconds / day.trackedSeconds) * 100)
    : 0;
  const topApp = day.topApp
    ? `<div style="color:${CHROME.axisLabel}">Top app: ${escapeHtml(cleanProcessName(day.topApp.process, aliases))} · ${fmtDuration(day.topApp.seconds)}</div>`
    : "";
  return [
    `<b>${date}</b>`,
    `<div>Tracked: ${fmtDuration(day.trackedSeconds)}</div>`,
    `<div>Productive: ${fmtDuration(day.productiveSeconds)} (${productiveShare}%)</div>`,
    `<div>Neutral: ${fmtDuration(day.neutralSeconds)}</div>`,
    `<div>Unproductive: ${fmtDuration(day.unproductiveSeconds)}</div>`,
    `<div>Uncategorized: ${fmtDuration(day.uncategorizedSeconds)}</div>`,
    topApp,
  ].join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
