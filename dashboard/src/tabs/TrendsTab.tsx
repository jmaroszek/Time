// Long-range views over full history: hour-of-day heatmap, calendar heatmap,
// week-over-week category trend.

import { useMemo, useState } from "react";

import EChart, { type EChartsOption } from "../components/EChart";
import { Card, Spinner } from "../components/ui";
import { fmtDuration } from "../lib/format";
import { duration, hourMatrix, type Session } from "../lib/metrics";
import { addDays, dayKey, listDays, startOfDay, startOfWeek } from "../lib/time";
import { useMeta } from "../state/meta";
import { useSessions } from "../state/useSessions";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TOOLTIP_STYLE = {
  backgroundColor: "#1d2026",
  borderColor: "#2a2e36",
  textStyle: { color: "#e8eaed", fontSize: 12 },
};

function compactHour(hour: number): string {
  const h = hour % 24;
  return `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
}

export default function TrendsTab() {
  // Computed once per mount: a fresh Date.now() on every render would change
  // the effect deps in useSessions and loop fetch -> render -> fetch forever.
  const [endSec] = useState(() => Math.floor(Date.now() / 1000) + 86_400);
  const { sessions, loading, error } = useSessions(0, endSec);

  if (loading) return <Spinner label="Loading full history..." />;
  if (error) return <p className="p-8 text-sm text-bad">DB error: {error}</p>;

  return (
    <div className="flex flex-col gap-4">
      <Card title="Weekly Hours by Category" titleAlign="center">
        <CategoryTrend sessions={sessions} />
      </Card>
      <Card
        title={
          <span className="flex flex-col items-center gap-1">
            <span>Average Productive Minutes by Hour</span>
            <span className="text-[11px] font-normal text-ink-3">
              Full history
            </span>
          </span>
        }
        titleAlign="center"
      >
        <HourHeatmap sessions={sessions} />
      </Card>
    </div>
  );
}

function HourHeatmap({ sessions }: { sessions: Session[] }) {
  const meta = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const isProd = (s: Session) => meta.classifier(s)?.isProductive === true;
    const matrix = hourMatrix(sessions, isProd);
    const occurrenceCounts = Array(7).fill(0) as number[];
    if (sessions.length > 0) {
      let firstSec = sessions[0].start;
      let lastSec = sessions[0].end;
      for (const session of sessions) {
        firstSec = Math.min(firstSec, session.start);
        lastSec = Math.max(lastSec, session.end);
      }
      const first = startOfDay(new Date(firstSec * 1000));
      const last = startOfDay(new Date(lastSec * 1000));
      for (const day of listDays({ start: first, end: addDays(last, 1) })) {
        occurrenceCounts[day.getDay()] += 1;
      }
    }
    // Only the configured hour window; x is the column index into it.
    const visibleHours: number[] = [];
    for (let h = meta.dayStartHour; h < meta.dayEndHour; h++) visibleHours.push(h);
    const data: [number, number, number][] = [];
    let maxMinutes = 0;
    for (let d = 0; d < 7; d++) {
      visibleHours.forEach((h, xi) => {
        const minutes = occurrenceCounts[d] > 0 ? matrix[d][h] / occurrenceCounts[d] / 60 : 0;
        maxMinutes = Math.max(maxMinutes, minutes);
        data.push([xi, d, Math.round(minutes * 10) / 10]);
      });
    }
    return {
      animation: false,
      grid: { left: 44, right: 16, top: 8, bottom: 28 },
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (p: { data: [number, number, number] }) =>
          `${DAY_NAMES[p.data[1]]} ${compactHour(visibleHours[p.data[0]])} · ${p.data[2].toFixed(1)} min average`,
      },
      xAxis: {
        type: "category",
        data: visibleHours.map(compactHour),
        axisLabel: { color: "#9aa0a8", fontSize: 10 },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      yAxis: {
        type: "category",
        data: DAY_NAMES,
        inverse: true, // Sunday on top, Saturday at the bottom
        axisLabel: { color: "#9aa0a8", fontSize: 11 },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      visualMap: {
        show: false,
        min: 0,
        max: Math.max(maxMinutes, 1),
        inRange: { color: ["#16181d", "#0e3a2c", "#1D9E75", "#5DCAA5"] },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: "#0f1115", borderWidth: 1.5, borderRadius: 2 },
        },
      ],
    };
  }, [sessions, meta.classifier, meta.dayStartHour, meta.dayEndHour]);

  return <EChart option={option} height={260} />;
}

function CategoryTrend({ sessions }: { sessions: Session[] }) {
  const meta = useMeta();
  const option = useMemo<EChartsOption>(() => {
    const now = new Date();
    const thisWeekStart = startOfWeek(now, meta.weekStart);
    const weeks: Date[] = [];
    for (let i = 11; i >= 0; i--) weeks.push(addDays(thisWeekStart, -7 * i));
    const weekIdx = new Map(weeks.map((w, i) => [dayKey(w), i]));

    const catNames = [
      ...meta.categories.filter((c) => !c.isIgnored).map((c) => c.name),
      "Uncategorized",
    ];
    const totals = new Map(catNames.map((n) => [n, Array(weeks.length).fill(0) as number[]]));

    const rangeStart = weeks[0].getTime() / 1000;
    for (const s of sessions) {
      if (s.isAfk || s.end <= rangeStart) continue;
      const cat = meta.classifier(s);
      if (cat?.isIgnored) continue;
      const name = cat?.name ?? "Uncategorized";
      const wk = dayKey(startOfWeek(startOfDay(new Date(s.start * 1000)), meta.weekStart));
      const idx = weekIdx.get(wk);
      if (idx === undefined) continue;
      totals.get(name)![idx] += duration(s) / 3600;
    }

    const colorByName = new Map(meta.categories.map((c) => [c.name, c.color]));
    return {
      animation: false,
      grid: { left: 36, right: 12, top: 28, bottom: 24 },
      tooltip: {
        trigger: "axis",
        ...TOOLTIP_STYLE,
        formatter: (params: { dataIndex: number; seriesName: string; value: number; marker: string }[]) => {
          if (!params.length) return "";
          const wk = weeks[params[0].dataIndex];
          const wkEnd = addDays(wk, 6);
          const head = `<b>Week of ${wk.getMonth() + 1}/${wk.getDate()} – ${wkEnd.getMonth() + 1}/${wkEnd.getDate()}</b>`;
          const lines = params
            .map((p) => `<div>${p.marker} ${p.seriesName}: ${fmtDuration(p.value * 3600)}</div>`)
            .join("");
          return head + lines;
        },
      },
      legend: { top: 0, textStyle: { color: "#9aa0a8", fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
      xAxis: {
        type: "category",
        // Each label is the week's START day; the bar covers that day + 6 after.
        data: weeks.map((w) => `${w.getMonth() + 1}/${w.getDate()}`),
        axisLabel: { color: "#9aa0a8", fontSize: 10 },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#2a2e36" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#9aa0a8", fontSize: 11, formatter: "{value}h" },
        splitLine: { lineStyle: { color: "#1d2026" } },
      },
      series: catNames
        .filter((name) => totals.get(name)!.some((v) => v > 0.01))
        .map((name) => ({
          name,
          type: "bar" as const,
          stack: "total",
          data: totals.get(name)!.map((v) => Math.round(v * 100) / 100),
          itemStyle: { color: colorByName.get(name) ?? "#5b616b" },
          barMaxWidth: 40,
        })),
    };
  }, [sessions, meta]);

  return <EChart option={option} height={280} />;
}
