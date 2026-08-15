import { useEffect, useMemo, useRef, useState } from "react";

import type { Category } from "../lib/classify";
import { fmtCompactHour, fmtDuration, fmtHourRange } from "../lib/format";
import type { ActivityStack, HourlyActivitySummary } from "../lib/overview";
import {
  CHART_FONT_FAMILY,
  CHART_LABEL_SIZE,
  chartChrome,
  stackedBarLegend,
  STACKED_BAR_LEGEND_GEOMETRY,
  tooltipStyle,
  uncategorizedBar,
} from "../lib/chartTheme";
import { useMeta } from "../state/meta";
import EChart, { type EChartsOption } from "./EChart";
import {
  categorySeries,
  estimateLegendRows,
  legendContentWidth,
  shouldShowUncategorized,
  type CategorySeries,
} from "./ProductiveHoursChart";

// Same per-row pitch ProductiveHoursChart measures its legend against — see its
// comment on LEGEND_ROW_H for why this has to be one constant, not two sites
// that are expected to agree.
const LEGEND_ROW_H = CHART_LABEL_SIZE + STACKED_BAR_LEGEND_GEOMETRY.itemGap;
const AXIS_BAND = 40;
const GRID_TOP = 12;

export default function HourlyActivityChart({
  hours,
  stackBy = "state",
  categories = [],
}: {
  hours: HourlyActivitySummary[];
  stackBy?: ActivityStack;
  categories?: Category[];
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

  const option = useMemo<EChartsOption>(() => {
    const chrome = chartChrome(theme);
    const toMinutes = (seconds: number) => Math.round(seconds / 6) / 10;
    const uncategorizedMinutes = hours.map((hour) => toMinutes(hour.uncategorizedSeconds));
    const hasUncategorized = shouldShowUncategorized(uncategorizedMinutes.map((minutes) => minutes / 60));

    const stateStacks: CategorySeries[] = [
      { name: "Productive", color: palette.productive, hours: hours.map((hour) => toMinutes(hour.productiveSeconds)) },
      { name: "Neutral", color: palette.neutral, hours: hours.map((hour) => toMinutes(hour.neutralSeconds)) },
      { name: "Unproductive", color: palette.unproductive, hours: hours.map((hour) => toMinutes(hour.unproductiveSeconds)) },
      ...(hasUncategorized
        ? [{ name: "Uncategorized", color: uncategorizedBar(theme), hours: uncategorizedMinutes }]
        : []),
    ];
    // Same decomposition ProductiveHoursChart uses for its category view, since
    // an hour bucket carries categorySeconds in the same shape a day bucket
    // does. Its output is hours (2-decimal precision); minutes here are just
    // that figure rescaled, not measured independently.
    const categoryStacks: CategorySeries[] = categorySeries(hours, categories, theme).map((stack) => ({
      ...stack,
      hours: stack.hours.map((h) => Math.round(h * 600) / 10),
    }));
    const stacks = stackBy === "category" ? categoryStacks : stateStacks;
    const stackNames = stacks.map((stack) => stack.name);
    const maxMinutes = Math.max(60, ...hours.map((hour) => Math.ceil(hour.trackedSeconds / 900) * 15));

    // Reserve the same grid height regardless of which stacking is active, so
    // toggling the control never changes how tall the bars read — see the
    // matching comment in ProductiveHoursChart.
    const legendWidth = legendContentWidth(chartWidth);
    const stateLabels = stateStacks.map((stack) => stack.name);
    const categoryLabels = categoryStacks.map((stack) => stack.name);
    const thisRows = estimateLegendRows(stackNames, legendWidth);
    const maxRows = Math.max(
      estimateLegendRows(stateLabels, legendWidth),
      estimateLegendRows(categoryLabels, legendWidth),
    );
    const bottomPad = AXIS_BAND + thisRows * LEGEND_ROW_H;
    const topPad = GRID_TOP + (maxRows - thisRows) * LEGEND_ROW_H;

    return {
      animation: false,
      textStyle: { fontFamily: CHART_FONT_FAMILY },
      grid: { left: 40, right: 12, top: topPad, bottom: bottomPad },
      tooltip: {
        trigger: "axis",
        ...tooltipStyle(theme),
        formatter: (params: Array<{ dataIndex: number; marker: string; seriesName: string; value: number }>) => {
          if (!params.length) return "";
          const hour = hours[params[0].dataIndex].hour;
          const rows = params
            .filter((param) => stackNames.includes(param.seriesName))
            .map((param) => `${param.marker}${param.seriesName}: <b>${fmtDuration(Number(param.value) * 60)}</b>`);
          return [`<b>${fmtHourRange(hour)}</b>`, ...rows].join("<br/>");
        },
      },
      legend: stackedBarLegend(chrome, stackNames),
      xAxis: {
        type: "category",
        data: hours.map((hour) => fmtCompactHour(hour.hour)),
        axisLabel: {
          color: chrome.axisLabel,
          fontSize: CHART_LABEL_SIZE,
          interval: hours.length > 12 ? 1 : 0,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: chrome.axisLine } },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: maxMinutes,
        interval: 15,
        axisLabel: { color: chrome.axisLabel, fontSize: CHART_LABEL_SIZE, formatter: "{value}m" },
        splitLine: { lineStyle: { color: chrome.gridLine } },
      },
      series: stacks.map((stack, index) => ({
        name: stack.name,
        type: "bar" as const,
        stack: "hour",
        data: stack.hours,
        itemStyle: {
          color: stack.color,
          // Only the topmost stack is rounded, so the bar reads as one shape.
          borderRadius: index === stacks.length - 1 ? [3, 3, 0, 0] : 0,
        },
        barMaxWidth: 24,
      })),
    };
  }, [hours, palette, theme, stackBy, categories, chartWidth]);

  return (
    <div ref={wrapRef}>
      <EChart option={option} height={254} />
    </div>
  );
}
