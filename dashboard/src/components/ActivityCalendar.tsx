import { useMemo, useRef } from "react";

import { DAY_NAMES, FULL_DAY_NAMES, MONTH_NAMES_LONG, fmtDuration } from "../lib/format";
import {
  metricSeconds,
  metricTrackedShare,
  ACTIVITY_METRIC_WORDS,
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
import { useMeta } from "../state/meta";
import { metricRamps } from "../lib/palettes";
import { CHART_FONT_FAMILY, CHART_LABEL_SIZE, chartChrome, tooltipStyle } from "../lib/chartTheme";
import EChart, { type EChartsOption } from "./EChart";
import { useElementWidth } from "../lib/responsive";

/** Above this many week columns, "auto" cell sizing lands near square by
 *  itself; below it the cells must be sized explicitly. */
const NARROW_WEEK_COLUMNS = 30;
/** A short calendar reads more naturally with weekdays across the top. Past
 *  this point, weeks running left-to-right use the card's width better. */
const VERTICAL_MAX_WEEKS = 8;

export default function ActivityCalendar({
  summaries,
  range,
  metric = "tracked",
}: {
  summaries: DailyActivitySummary[];
  range: Range;
  metric?: ActivityMetric;
}) {
  const { weekStart, palette, theme } = useMeta();
  const containerRef = useRef<HTMLDivElement>(null);
  const availableWidth = useElementWidth(containerRef, 440);
  const option = useMemo<EChartsOption>(() => {
    const chrome = chartChrome(theme);
    const byKey = new Map(summaries.map((day) => [day.key, day]));
    const shaded = (day: DailyActivitySummary) => metricSeconds(day, metric);
    // Rescaled per metric: every state is a subset of tracked, so reusing the
    // tracked scale would wash the narrower fields out.
    const maxHours = Math.max(...summaries.map((day) => shaded(day) / 3600), 1);
    const ramp = metricRamps(palette, theme)[metric];
    const lastDay = addDays(range.end, -1);
    // A week-column count low enough that "auto" would stretch each cell into a
    // wide bar instead of a day. Below it, size the cells squarely and center
    // the grid; the box must be given an explicit width/height rather than
    // left+right+top+bottom, because a fully constrained box overrides cellSize.
    const { weekColumns, cellPx, orientation } = calendarGrid(range, weekStart, availableWidth);
    const vertical = orientation === "vertical";

    return {
      animation: false,
      textStyle: { fontFamily: CHART_FONT_FAMILY },
      tooltip: {
        ...tooltipStyle(theme),
        formatter: (params: { data: [string, number] }) => {
          const day = byKey.get(params.data[0]);
          return day ? formatActivityCalendarTooltip(day, metric) : "";
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
          borderColor: chrome.gridLine,
          borderWidth: 2,
        },
        dayLabel: {
          firstDay: weekStart === "Monday" ? 1 : 0,
          nameMap: DAY_NAMES,
          color: chrome.axisLabel,
          fontSize: CHART_LABEL_SIZE,
          margin: 8,
        },
        monthLabel: {
          color: chrome.axisLabel,
          fontSize: CHART_LABEL_SIZE,
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
  }, [summaries, metric, weekStart, range, palette, theme, availableWidth]);

  const { weekColumns, cellPx, orientation } = calendarGrid(range, weekStart, availableWidth);
  const rows = orientation === "vertical" ? weekColumns : 7;
  return (
    <div ref={containerRef} className="min-w-0 overflow-hidden">
      <EChart option={option} height={cellPx === null ? 220 : cellPx * rows + 56} />
    </div>
  );
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
  availableWidth: number,
): { weekColumns: number; cellPx: number | null; orientation: "horizontal" | "vertical" } {
  // calendarDays, not raw ms — a range spanning a DST boundary is off by an
  // hour, which rounds up into a phantom extra column.
  const weekColumns = Math.ceil(
    calendarDays({ start: startOfWeek(range.start, weekStart), end: range.end }) / 7,
  );
  const orientation = weekColumns <= VERTICAL_MAX_WEEKS ? "vertical" : "horizontal";
  // Reserve label and card breathing room before sizing the square grid. A
  // long calendar may use 12px cells at the minimum window, but it never makes
  // the document wider than the card that owns it.
  const gridColumns = orientation === "vertical" ? 7 : weekColumns;
  const usableWidth = Math.max(1, availableWidth - (orientation === "vertical" ? 12 : 60));
  const cellPx = weekColumns <= NARROW_WEEK_COLUMNS
    ? Math.max(12, Math.min(40, Math.floor(usableWidth / gridColumns)))
    : null;
  return {
    weekColumns,
    cellPx,
    orientation,
  };
}

export function formatActivityCalendarTooltip(
  day: DailyActivitySummary,
  metric: ActivityMetric = "tracked",
): string {
  const date = `${FULL_DAY_NAMES[day.date.getDay()]}, ${MONTH_NAMES_LONG[day.date.getMonth()]} ${day.date.getDate()}, ${day.date.getFullYear()}`;
  const topApp = metric === "tracked" && day.topApp
    ? `<div class="chart-tip-muted">Top app: ${escapeHtml(day.topApp.name)} · ${fmtDuration(day.topApp.seconds)}</div>`
    : "";
  const share = metricTrackedShare(day, metric);
  const word = ACTIVITY_METRIC_WORDS[metric];
  const label = word.replace(/^./, (c) => c.toUpperCase());
  return [
    `<b>${date}</b>`,
    `<div>${label}: ${fmtDuration(metricSeconds(day, metric))}</div>`,
    share === null
      ? ""
      : `<div class="chart-tip-muted">${share}% of tracked time</div>`,
    metric === "productive"
      ? `<div class="chart-tip-muted">Longest focus: ${fmtDuration(day.longestFocusSeconds)}</div>`
      : "",
    topApp,
  ].join("");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
