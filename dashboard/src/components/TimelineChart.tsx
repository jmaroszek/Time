// Day timeline: one row per day, colored segments per session category.
// ECharts custom series; click a segment for the drill-down panel.

import { useCallback, useMemo } from "react";
import type { ECElementEvent } from "echarts";

import type { Classifier } from "../lib/classify";
import { clipSessions, splitAtMidnights, type Session } from "../lib/metrics";
import { dayKey, listDays, type Range } from "../lib/time";
import { fmtClock, fmtDayLabel, fmtDuration, cleanProcessName } from "../lib/format";
import EChart, { type EChartsOption } from "./EChart";

const AFK_COLOR = "#33363d";
const UNCATEGORIZED_COLOR = "#5b616b";

export interface TimelineSegment {
  process: string;
  title: string;
  categoryName: string;
  color: string;
  startSec: number;
  endSec: number;
  isAfk: boolean;
}

export default function TimelineChart({
  sessions,
  range,
  classifier,
  onSelect,
}: {
  sessions: Session[];
  range: Range;
  classifier: Classifier;
  onSelect?: (seg: TimelineSegment) => void;
}) {
  const days = useMemo(() => listDays(range).reverse(), [range]); // newest on top
  const dayIndex = useMemo(
    () => new Map(days.map((d, i) => [dayKey(d), i])),
    [days],
  );

  const segments = useMemo(() => {
    const out: { value: number[]; seg: TimelineSegment }[] = [];
    const startSec = range.start.getTime() / 1000;
    const endSec = range.end.getTime() / 1000;
    for (const s of clipSessions(sessions, startSec, endSec)) {
      const cat = classifier(s);
      const color = s.isAfk ? AFK_COLOR : (cat?.color ?? UNCATEGORIZED_COLOR);
      const categoryName = s.isAfk ? "AFK" : (cat?.name ?? "Uncategorized");
      for (const chunk of splitAtMidnights(s.start, s.end)) {
        const idx = dayIndex.get(dayKey(chunk.dayStart));
        if (idx === undefined) continue;
        const dayStartSec = chunk.dayStart.getTime() / 1000;
        const h0 = (chunk.startSec - dayStartSec) / 3600;
        const h1 = (chunk.endSec - dayStartSec) / 3600;
        if (h1 - h0 < 0.002 && !s.isAfk) continue; // skip sub-7s slivers for render perf
        out.push({
          value: [idx, h0, h1],
          seg: {
            process: s.process,
            title: s.title,
            categoryName,
            color,
            startSec: chunk.startSec,
            endSec: chunk.endSec,
            isAfk: s.isAfk,
          },
        });
      }
    }
    return out;
  }, [sessions, range, classifier, dayIndex]);

  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { left: 70, right: 16, top: 8, bottom: 24 },
      xAxis: {
        type: "value",
        min: 0,
        max: 24,
        interval: 3,
        axisLabel: {
          color: "#9aa0a8",
          fontSize: 11,
          formatter: (h: number) =>
            h === 0 || h === 24 ? "12am" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`,
        },
        splitLine: { lineStyle: { color: "#1d2026" } },
      },
      yAxis: {
        type: "category",
        data: days.map(fmtDayLabel),
        inverse: true,
        axisLabel: { color: "#9aa0a8", fontSize: 11 },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      tooltip: {
        backgroundColor: "#1d2026",
        borderColor: "#2a2e36",
        textStyle: { color: "#e8eaed", fontSize: 12 },
        formatter: (p: { data: { seg: TimelineSegment } }) => {
          const seg = p.data.seg;
          const head = seg.isAfk
            ? `AFK (${seg.title || "idle"})`
            : `<b>${cleanProcessName(seg.process)}</b> · ${seg.categoryName}`;
          const titleLine =
            !seg.isAfk && seg.title
              ? `<div style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0a8">${escapeHtml(seg.title)}</div>`
              : "";
          return `${head}${titleLine}<div>${fmtClock(seg.startSec)}–${fmtClock(seg.endSec)} · ${fmtDuration(seg.endSec - seg.startSec)}</div>`;
        },
      },
      series: [
        {
          type: "custom",
          encode: { x: [1, 2], y: 0 },
          data: segments.map((s) => ({
            value: s.value,
            seg: s.seg,
            itemStyle: { color: s.seg.color, opacity: s.seg.isAfk ? 0.45 : 1 },
          })),
          renderItem: (
            _params: unknown,
            api: {
              value: (i: number) => number;
              coord: (p: number[]) => number[];
              size: (p: number[]) => number[];
              style: () => Record<string, unknown>;
            },
          ) => {
            const dayIdx = api.value(0);
            const start = api.coord([api.value(1), dayIdx]);
            const end = api.coord([api.value(2), dayIdx]);
            const bandHeight = api.size([0, 1])[1];
            const height = Math.min(bandHeight * 0.55, 22);
            return {
              type: "rect",
              shape: {
                x: start[0],
                y: start[1] - height / 2,
                width: Math.max(end[0] - start[0], 1),
                height,
                r: 2,
              },
              style: api.style(),
            };
          },
        },
      ],
    }),
    [segments, days],
  );

  const handleClick = useCallback(
    (params: ECElementEvent) => {
      const data = params.data as { seg?: TimelineSegment } | undefined;
      if (data?.seg && onSelect) onSelect(data.seg);
    },
    [onSelect],
  );

  return <EChart option={option} height={Math.max(days.length * 34 + 40, 110)} onClick={handleClick} />;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
