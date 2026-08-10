// Shared body of the metric tooltips the heatmap views draw. The calendar, the
// month calendar and the rhythm grid are the same view at different zoom levels
// — the month calendar's own header calls itself the day calendar "zoomed out
// one level" — so a tooltip that differs between them reads as a bug rather
// than a variation. They each held their own copy of this.

import { fmtDuration } from "./format";
import {
  ACTIVITY_METRIC_WORDS,
  metricSeconds,
  metricTrackedShare,
  type ActivityMetric,
  type ActivityTotals,
} from "./overview";

/**
 * ECharts tooltip formatters return an HTML string, and the values reaching
 * them are untrusted: window titles, process names and user category names all
 * arrive verbatim from the tracked machine.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A secondary row: present but subordinate to the headline figure. */
export function tooltipMutedRow(html: string): string {
  return `<div class="chart-tip-muted">${html}</div>`;
}

/** The metric's name as a sentence-leading word, e.g. "Productive". */
export function metricLabel(metric: ActivityMetric): string {
  return ACTIVITY_METRIC_WORDS[metric].replace(/^./, (c) => c.toUpperCase());
}

interface MetricTooltipOptions {
  /** Bold first line — the only part that is genuinely per-view. */
  headline: string;
  /** Leader for the figure, e.g. "Productive" or "Avg productive". */
  valueLabel: string;
  /**
   * Renders the metric's seconds. Defaults to the raw duration; the rhythm grid
   * divides by how many of that weekday the range holds, so its cells report an
   * average rather than a total.
   */
  formatValue?: (seconds: number) => string;
  /** Appended after the top app's duration, e.g. " total". */
  topAppSuffix?: string;
  /**
   * Longest productive chain in the bucket. Supplied by the caller rather than
   * read off `totals`: a rhythm cell is one hour of one weekday across the whole
   * range, which is not a span a focus chain can be measured over, so it has no
   * such field and omits the row.
   */
  longestFocusSeconds?: number;
}

export function metricTooltipBody(
  totals: ActivityTotals & { topApp: { name: string; seconds: number } | null },
  metric: ActivityMetric,
  options: MetricTooltipOptions,
): string {
  const {
    headline,
    valueLabel,
    formatValue = fmtDuration,
    topAppSuffix = "",
    longestFocusSeconds,
  } = options;
  const share = metricTrackedShare(totals, metric);
  return [
    `<b>${headline}</b>`,
    `<div>${valueLabel}: ${formatValue(metricSeconds(totals, metric))}</div>`,
    share === null ? "" : tooltipMutedRow(`${share}% of tracked time`),
    metric === "productive" && longestFocusSeconds !== undefined
      ? tooltipMutedRow(`Longest focus: ${fmtDuration(longestFocusSeconds)}`)
      : "",
    // Only the total view names an app: under a state metric the busiest app
    // overall is not necessarily the one that earned the state being shaded.
    metric === "tracked" && totals.topApp
      ? tooltipMutedRow(
          `Top app: ${escapeHtml(totals.topApp.name)} · ${fmtDuration(totals.topApp.seconds)}${topAppSuffix}`,
        )
      : "",
  ].join("");
}
