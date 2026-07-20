import { useMemo } from "react";

import { cleanProcessName, fmtDuration } from "../lib/format";
import {
  dailyActivitySummaries,
  metricSeconds,
  type ActivityMetric,
  type DailyActivitySummary,
} from "../lib/overview";
import {
  addDays,
  calendarDays,
  dayKey,
  startOfWeek,
  type Range,
  type WeekStart,
} from "../lib/time";
import type { Classifier } from "../lib/classify";
import type { Session } from "../lib/metrics";
import { useMeta } from "../state/meta";
import { ACTIVITY_METRIC_RAMPS, CHROME, TOOLTIP_STYLE } from "../lib/chartTheme";
import EChart, { type EChartsOption } from "./EChart";

/** Above this many week columns, "auto" cell sizing lands near square by
 *  itself; below it the cells must be sized explicitly. */
const NARROW_WEEK_COLUMNS = 30;
/** A short calendar reads more naturally with weekdays across the top. Past
 *  this point, weeks running left-to-right use the card's width better. */
const VERTICAL_MAX_WEEKS = 8;

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
  metric = "tracked",
}: {
  sessions: Session[];
  range: Range;
  classifier: Classifier;
  metric?: ActivityMetric;
}) {
  const { aliases, weekStart } = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const summaries = dailyActivitySummaries(sessions, range, classifier);
    const byKey = new Map(summaries.map((day) => [day.key, day]));
    const shaded = (day: DailyActivitySummary) => metricSeconds(day, metric);
    // Rescaled per metric: every state is a subset of tracked, so reusing the
    // tracked scale would wash the narrower fields out.
    const maxHours = Math.max(...summaries.map((day) => shaded(day) / 3600), 1);
    const ramp = ACTIVITY_METRIC_RAMPS[metric];
    const lastDay = addDays(range.end, -1);
    // A week-column count low enough that "auto" would stretch each cell into a
    // wide bar instead of a day. Below it, size the cells squarely and center
    // the grid; the box must be given an explicit width/height rather than
    // left+right+top+bottom, because a fully constrained box overrides cellSize.
    const { weekColumns, cellPx, orientation } = calendarGrid(range, weekStart);
    const vertical = orientation === "vertical";

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
        inRange: { color: ramp },
      },
      calendar: {
        top: 28,
        orient: orientation,
        ...(cellPx === null
          ? { left: 48, right: 12, bottom: 12, cellSize: ["auto", 18] }
          : {
              left: "center",
              width: cellPx * (vertical ? 7 : weekColumns),
              height: cellPx * (vertical ? weekColumns : 7),
              cellSize: [cellPx, cellPx],
            }),
        range: [dayKey(range.start), dayKey(lastDay)],
        splitLine: { show: false },
        itemStyle: {
          // Empty-day fill: the ramp's own zero stop, so days with no data sit
          // flush with the low end of whichever scale is showing.
          color: ramp[0],
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
          data: summaries.map((day) => [day.key, Math.round((shaded(day) / 3600) * 100) / 100]),
        },
      ],
    };
  }, [sessions, range, classifier, metric, aliases, weekStart]);

  const { weekColumns, cellPx, orientation } = calendarGrid(range, weekStart);
  const rows = orientation === "vertical" ? weekColumns : 7;
  return <EChart option={option} height={cellPx === null ? 220 : cellPx * rows + 56} />;
}

/**
 * Weeks in the range, the square cell size, and the most legible orientation.
 *
 * Short ranges use familiar calendar reading order: weekdays across and weeks
 * down. Longer ranges keep weeks across so time uses the card's width. For both
 * orientations, explicit square sizing prevents short ranges from stretching
 * each day into a bar; sufficiently long ranges can safely use auto width.
 */
export function calendarGrid(
  range: Range,
  weekStart: WeekStart,
): { weekColumns: number; cellPx: number | null; orientation: "horizontal" | "vertical" } {
  // calendarDays, not raw ms — a range spanning a DST boundary is off by an
  // hour, which rounds up into a phantom extra column.
  const weekColumns = Math.ceil(
    calendarDays({ start: startOfWeek(range.start, weekStart), end: range.end }) / 7,
  );
  const cellPx =
    weekColumns <= NARROW_WEEK_COLUMNS
      ? Math.max(18, Math.min(40, Math.floor(880 / weekColumns)))
      : null;
  return {
    weekColumns,
    cellPx,
    orientation: weekColumns <= VERTICAL_MAX_WEEKS ? "vertical" : "horizontal",
  };
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
