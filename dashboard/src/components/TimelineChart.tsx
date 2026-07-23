// Day timeline: one row per day. Two view modes:
//   blockMinutes > 0  — fixed blocks colored by dominant category (default;
//                       smooths fragmented data and multi-app workflows)
//   blockMinutes == 0 — exact session segments
// ECharts custom series; hover a segment for its breakdown tooltip.

import { useMemo } from "react";

import type { Classifier } from "../lib/classify";
import { aggregateBlocks } from "../lib/blocks";
import { clipSessions, splitAtMidnights, type Session } from "../lib/metrics";
import { dayKey, listDays, type Range } from "../lib/time";
import { fmtClock, fmtDayLabel, fmtDuration, cleanProcessName } from "../lib/format";
import { useMeta } from "../state/meta";
import EChart, { type EChartsOption } from "./EChart";
import { CHROME, TOOLTIP_STYLE } from "../lib/chartTheme";

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
  /** Block mode only: per-app composition and actual active seconds. */
  breakdown?: { process: string; seconds: number }[];
  activeSec?: number;
}

interface SegmentDatum {
  value: number[]; // [dayIdx, startHour, endHour]
  seg: TimelineSegment;
}

export default function TimelineChart({
  sessions,
  range,
  classifier,
  blockMinutes,
}: {
  sessions: Session[];
  range: Range;
  classifier: Classifier;
  blockMinutes: number; // 0 = exact sessions
}) {
  const { aliases, dayStartHour, dayEndHour } = useMeta();
  const days = useMemo(() => listDays(range), [range]); // oldest on top, reads top-to-bottom
  const dayIndex = useMemo(() => new Map(days.map((d, i) => [dayKey(d), i])), [days]);

  const segments = useMemo<SegmentDatum[]>(() => {
    if (blockMinutes > 0) {
      return aggregateBlocks(sessions, range, classifier, blockMinutes).flatMap((b) => {
        const idx = dayIndex.get(b.dayKey);
        if (idx === undefined) return [];
        return [
          {
            value: [idx, b.startHour, b.endHour],
            seg: {
              process: b.apps[0]?.process ?? "",
              title: "",
              categoryName: b.categoryName,
              color: b.color ?? AFK_COLOR,
              startSec: b.startSec,
              endSec: b.endSec,
              isAfk: b.isAfk,
              breakdown: b.apps,
              activeSec: b.activeSec,
            },
          },
        ];
      });
    }

    const out: SegmentDatum[] = [];
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
  }, [sessions, range, classifier, dayIndex, blockMinutes]);

  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { left: 70, right: 16, top: 8, bottom: 24 },
      xAxis: {
        type: "value",
        min: dayStartHour,
        max: dayEndHour,
        interval: 3,
        axisLabel: {
          color: CHROME.axisLabel,
          fontSize: 11,
          formatter: (h: number) =>
            h === 0 || h === 24 ? "12am" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`,
        },
        splitLine: { lineStyle: { color: CHROME.gridLine } },
      },
      yAxis: {
        type: "category",
        data: days.map(fmtDayLabel),
        inverse: true,
        axisLabel: { color: CHROME.axisLabel, fontSize: 11 },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      tooltip: {
        ...TOOLTIP_STYLE,
        formatter: (p: { data: { seg: TimelineSegment } }) => formatTooltip(p.data.seg, aliases),
      },
      series: [
        {
          type: "custom",
          clip: true, // trim segments that fall outside the visible hour window
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
    [segments, days, aliases, dayStartHour, dayEndHour],
  );

  const chart = (
    <EChart option={option} height={Math.max(days.length * 34 + 40, 110)} />
  );
  return days.length > 14
    ? <div className="scroll-well max-h-[516px] overflow-y-auto pr-1">{chart}</div>
    : chart;
}

function formatTooltip(seg: TimelineSegment, aliases?: Record<string, string>): string {
  const window = `${fmtClock(seg.startSec)}–${fmtClock(seg.endSec)}`;
  if (seg.breakdown) {
    if (seg.isAfk) return `AFK · ${window}`;
    const apps = seg.breakdown
      .slice(0, 4)
      .map(
        (a) =>
          `<div style="color:${CHROME.axisLabel}">${escapeHtml(cleanProcessName(a.process, aliases))} · ${fmtDuration(a.seconds)}</div>`,
      )
      .join("");
    return `<b>${escapeHtml(seg.categoryName)}</b> · ${window}<div>${fmtDuration(seg.activeSec ?? 0)} active</div>${apps}`;
  }
  const head = seg.isAfk
    ? `AFK (${seg.title || "idle"})`
    : `<b>${escapeHtml(cleanProcessName(seg.process, aliases))}</b> · ${escapeHtml(seg.categoryName)}`;
  const titleLine =
    !seg.isAfk && seg.title
      ? `<div style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${CHROME.axisLabel}">${escapeHtml(seg.title)}</div>`
      : "";
  return `${head}${titleLine}<div>${window} · ${fmtDuration(seg.endSec - seg.startSec)}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
