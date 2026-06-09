// Productive hours per day (bars) with a 7-day trailing average (dashed line).
// `historySessions` should cover 6 extra days before the range so the average
// is correct from the first visible day.

import { useMemo } from "react";

import type { Classifier } from "../lib/classify";
import { dailySeconds, rollingMean, type Session } from "../lib/metrics";
import { addDays, dayKey, listDays, type Range } from "../lib/time";
import { fmtShortDate } from "../lib/format";
import EChart, { type EChartsOption } from "./EChart";

export default function ProductiveHoursChart({
  historySessions,
  range,
  classifier,
}: {
  historySessions: Session[];
  range: Range;
  classifier: Classifier;
}) {
  const option = useMemo<EChartsOption>(() => {
    const extendedRange: Range = { start: addDays(range.start, -6), end: range.end };
    const isProd = (s: Session) => classifier(s)?.isProductive === true;
    const daily = dailySeconds(historySessions, isProd, extendedRange);
    const extendedDays = listDays(extendedRange);
    const hours = extendedDays.map((d) => (daily.get(dayKey(d)) ?? 0) / 3600);
    const avg = rollingMean(hours, 7);

    const visibleDays = listDays(range);
    const offset = extendedDays.length - visibleDays.length;
    const barData = hours.slice(offset).map((h) => Math.round(h * 100) / 100);
    const avgData = avg.slice(offset).map((h) => Math.round(h * 100) / 100);

    return {
      animation: false,
      grid: { left: 36, right: 12, top: 24, bottom: 24 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#1d2026",
        borderColor: "#2a2e36",
        textStyle: { color: "#e8eaed", fontSize: 12 },
        valueFormatter: (v: number) => `${v.toFixed(1)}h`,
      },
      legend: {
        show: true,
        top: 0,
        right: 0,
        textStyle: { color: "#9aa0a8", fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      xAxis: {
        type: "category",
        data: visibleDays.map(fmtShortDate),
        axisLabel: { color: "#9aa0a8", fontSize: 11 },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#2a2e36" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#9aa0a8", fontSize: 11, formatter: "{value}h" },
        splitLine: { lineStyle: { color: "#1d2026" } },
      },
      series: [
        {
          name: "Productive",
          type: "bar",
          data: barData,
          itemStyle: { color: "#1D9E75", borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 36,
        },
        {
          name: "7-day avg",
          type: "line",
          data: avgData,
          symbol: "none",
          lineStyle: { color: "#7F77DD", width: 2, type: "dashed" },
          itemStyle: { color: "#7F77DD" },
        },
      ],
    };
  }, [historySessions, range, classifier]);

  return <EChart option={option} height={240} />;
}
