import { useMemo } from "react";

import { fmtDuration } from "../lib/format";
import type { HourlyActivitySummary } from "../lib/overview";
import { CHROME, TOOLTIP_STYLE, UNCATEGORIZED_BAR } from "../lib/chartTheme";
import { useMeta } from "../state/meta";
import EChart, { type EChartsOption } from "./EChart";
import { shouldShowUncategorized } from "./ProductiveHoursChart";

export default function HourlyActivityChart({
  hours,
}: {
  hours: HourlyActivitySummary[];
}) {
  const { palette } = useMeta();
  const option = useMemo<EChartsOption>(() => {
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
      grid: { left: 40, right: 12, top: 12, bottom: hasUncategorized ? 76 : 58 },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP_STYLE,
        formatter: (params: Array<{ dataIndex: number; marker: string; seriesName: string; value: number }>) => {
          if (!params.length) return "";
          const hour = hours[params[0].dataIndex].hour;
          const rows = params
            .filter((param) => stackNames.includes(param.seriesName))
            .map((param) => `${param.marker}${param.seriesName}: <b>${fmtDuration(Number(param.value) * 60)}</b>`);
          return [`<b>${formatHourRange(hour)}</b>`, ...rows].join("<br/>");
        },
      },
      legend: {
        show: true,
        bottom: 0,
        left: "center",
        width: "92%",
        data: stackNames,
        textStyle: { color: CHROME.axisLabel, fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      xAxis: {
        type: "category",
        data: hours.map((hour) => compactHour(hour.hour)),
        axisLabel: {
          color: CHROME.axisLabel,
          fontSize: 11,
          interval: hours.length > 12 ? 1 : 0,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHROME.axisLine } },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: maxMinutes,
        interval: 15,
        axisLabel: { color: CHROME.axisLabel, fontSize: 11, formatter: "{value}m" },
        splitLine: { lineStyle: { color: CHROME.gridLine } },
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
              itemStyle: { color: UNCATEGORIZED_BAR, borderRadius: [3, 3, 0, 0] },
              barMaxWidth: 24,
            }]
          : []),
      ],
    };
  }, [hours, palette]);

  return <EChart option={option} height={254} />;
}

function compactHour(hour: number): string {
  const normalized = hour % 24;
  return `${normalized % 12 || 12}${normalized < 12 ? "am" : "pm"}`;
}

function formatHourRange(hour: number): string {
  return `${compactHour(hour)}–${compactHour(hour + 1)}`;
}
