// Daily hours: productive (teal) with non-productive stacked in gray on top,
// plus a 7-day trailing average of PRODUCTIVE hours (dashed line).
// `historySessions` should cover 6 extra days before the range so the average
// is correct from the first visible day.

import { useMemo } from "react";

import type { Classifier } from "../lib/classify";
import { dailySeconds, rollingMean, type Session } from "../lib/metrics";
import { addDays, dayKey, listDays, type Range } from "../lib/time";
import { fmtShortDate } from "../lib/format";
import EChart, { type EChartsOption } from "./EChart";
import { ANNOTATION, CHROME, GOOD_DATA, NON_PRODUCTIVE_BAR, TOOLTIP_STYLE } from "../lib/chartTheme";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PRODUCTIVE_AVG = "7-day productive avg";

export default function ProductiveHoursChart({
  historySessions,
  range,
  classifier,
  labelMode = "date",
}: {
  historySessions: Session[];
  range: Range;
  classifier: Classifier;
  labelMode?: "weekday" | "date";
}) {
  const option = useMemo<EChartsOption>(() => {
    const extendedRange: Range = { start: addDays(range.start, -6), end: range.end };
    const isProd = (s: Session) => classifier(s)?.isProductive === true;
    const isNonProd = (s: Session) => classifier(s)?.isProductive !== true;
    const prodDaily = dailySeconds(historySessions, isProd, extendedRange);
    const nonProdDaily = dailySeconds(historySessions, isNonProd, range);
    const extendedDays = listDays(extendedRange);
    const hours = extendedDays.map((d) => (prodDaily.get(dayKey(d)) ?? 0) / 3600);
    const avg = rollingMean(hours, 7);

    const visibleDays = listDays(range);
    const offset = extendedDays.length - visibleDays.length;
    const round2 = (h: number) => Math.round(h * 100) / 100;
    const prodBars = hours.slice(offset).map(round2);
    const nonProdBars = visibleDays.map((d) => round2((nonProdDaily.get(dayKey(d)) ?? 0) / 3600));
    const avgLine = avg.slice(offset).map(round2);

    return {
      animation: false,
      grid: { left: 36, right: 12, top: 12, bottom: 58 },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP_STYLE,
        formatter: (params: Array<{ axisValueLabel: string; marker: string; seriesName: string; value: number }>) => {
          const byName = new Map(params.map((p) => [p.seriesName, p]));
          const rows = [PRODUCTIVE_AVG, "Productive", "Non-productive"]
            .map((name) => byName.get(name))
            .filter((p): p is NonNullable<typeof p> => p !== undefined)
            .map((p) => `${p.marker}${p.seriesName}: <b>${Number(p.value).toFixed(1)}h</b>`);
          return [params[0]?.axisValueLabel, ...rows].filter(Boolean).join("<br/>");
        },
      },
      legend: {
        show: true,
        bottom: 0,
        left: "center",
        data: [
          "Productive",
          "Non-productive",
          {
            name: PRODUCTIVE_AVG,
            icon: "path://M0,4 L4,4 L4,6 L0,6 Z M6,4 L10,4 L10,6 L6,6 Z M12,4 L16,4 L16,6 L12,6 Z",
          },
        ],
        textStyle: { color: CHROME.axisLabel, fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      xAxis: {
        type: "category",
        data: visibleDays.map((d) =>
          labelMode === "weekday" ? DAY_NAMES[d.getDay()] : fmtShortDate(d),
        ),
        axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHROME.axisLine } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: CHROME.axisLabel, fontSize: 11, formatter: "{value}h" },
        splitLine: { lineStyle: { color: CHROME.gridLine } },
      },
      series: [
        {
          name: "Productive",
          type: "bar",
          stack: "day",
          data: prodBars,
          itemStyle: { color: GOOD_DATA },
          barMaxWidth: 36,
        },
        {
          name: "Non-productive",
          type: "bar",
          stack: "day",
          data: nonProdBars,
          itemStyle: { color: NON_PRODUCTIVE_BAR, borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 36,
        },
        {
          name: PRODUCTIVE_AVG,
          type: "line",
          data: avgLine,
          symbol: "none",
          lineStyle: { color: ANNOTATION, width: 2, type: "dashed" },
          itemStyle: { color: ANNOTATION },
        },
      ],
    };
  }, [historySessions, range, classifier, labelMode]);

  return <EChart option={option} height={254} />;
}
