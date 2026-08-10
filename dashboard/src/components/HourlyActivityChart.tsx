import { useMemo } from "react";

import { fmtCompactHour, fmtDuration, fmtHourRange } from "../lib/format";
import type { HourlyActivitySummary } from "../lib/overview";
import {
  CHART_FONT_FAMILY,
  CHART_LABEL_SIZE,
  chartChrome,
  stackedBarLegend,
  tooltipStyle,
  uncategorizedBar,
} from "../lib/chartTheme";
import { useMeta } from "../state/meta";
import EChart, { type EChartsOption } from "./EChart";
import { shouldShowUncategorized } from "./ProductiveHoursChart";

export default function HourlyActivityChart({
  hours,
}: {
  hours: HourlyActivitySummary[];
}) {
  const { palette, theme } = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const chrome = chartChrome(theme);
    const toMinutes = (seconds: number) => Math.round(seconds / 6) / 10;
    const productive = hours.map((hour) => toMinutes(hour.productiveSeconds));
    const neutral = hours.map((hour) => toMinutes(hour.neutralSeconds));
    const unproductive = hours.map((hour) => toMinutes(hour.unproductiveSeconds));
    const uncategorized = hours.map((hour) => toMinutes(hour.uncategorizedSeconds));
    const hasUncategorized = shouldShowUncategorized(uncategorized.map((minutes) => minutes / 60));
    const stackNames = ["Productive", "Neutral", "Unproductive", ...(hasUncategorized ? ["Uncategorized"] : [])];
    const maxMinutes = Math.max(
      60,
      ...hours.map((hour) => Math.ceil((
        hour.productiveSeconds
        + hour.neutralSeconds
        + hour.unproductiveSeconds
        + hour.uncategorizedSeconds
      ) / 900) * 15),
    );

    return {
      animation: false,
      textStyle: { fontFamily: CHART_FONT_FAMILY },
      grid: { left: 40, right: 12, top: 12, bottom: hasUncategorized ? 84 : 62 },
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
      series: [
        {
          name: "Productive",
          type: "bar",
          stack: "hour",
          data: productive,
          itemStyle: { color: palette.productive },
          barMaxWidth: 24,
        },
        {
          name: "Neutral",
          type: "bar",
          stack: "hour",
          data: neutral,
          itemStyle: { color: palette.neutral },
          barMaxWidth: 24,
        },
        {
          name: "Unproductive",
          type: "bar",
          stack: "hour",
          data: unproductive,
          itemStyle: {
            color: palette.unproductive,
            borderRadius: hasUncategorized ? 0 : [3, 3, 0, 0],
          },
          barMaxWidth: 24,
        },
        ...(hasUncategorized
          ? [{
              name: "Uncategorized",
              type: "bar" as const,
              stack: "hour",
              data: uncategorized,
              itemStyle: { color: uncategorizedBar(theme), borderRadius: [3, 3, 0, 0] },
              barMaxWidth: 24,
            }]
          : []),
      ],
    };
  }, [hours, palette]);

  return <EChart option={option} height={254} />;
}
