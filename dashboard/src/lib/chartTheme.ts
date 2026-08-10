import { DEFAULT_PALETTE, metricRamps, rampSurface } from "./palettes";
import type { ThemeName } from "./theme";

// Palette-invariant chart chrome and semantic data colours. The category swatches
// and the three productivity-state colours are NOT here — they vary by the
// selected palette and live in palettes.ts, read through meta.palette. ECharts
// can't read CSS custom properties, so the values below live here; each is
// annotated with the index.css token it mirrors. Hex literals in components
// should route through this module, palettes.ts, or the CSS tokens — nowhere else.
//
// Everything that follows the theme is a function of it rather than a constant.
// That is the one part of the light theme with any architectural weight: the
// literals cannot be removed, so they are keyed by theme instead, and the charts
// take `meta.theme` and re-render when it changes.

/**
 * The UI typeface, mirrored for canvas. Charts must set this explicitly: left
 * alone, ECharts' global default is "Microsoft YaHei" on any Windows machine
 * (a `navigator.platform` sniff in echarts/lib/model/globalDefault.js), which
 * set every axis, legend, and tooltip ~9% wider than the rest of the app and in
 * visibly different shapes. Keep in step with `body` in index.css — layout code
 * that measures text (see ProductiveHoursChart's legend) assumes they match.
 */
export const CHART_FONT_FAMILY = '"Segoe UI", system-ui, sans-serif';

/** Axis labels and gridlines are metadata, so they take the metadata step of the
 *  type scale rather than a size of their own. Mirrors --text-meta. */
export const CHART_LABEL_SIZE = 11.5;

/**
 * The label type as a CSS `font` shorthand, for code that measures chart text on
 * a canvas to predict what ECharts will lay out.
 *
 * Derived rather than written out: a measurement font that disagrees with the
 * rendered one is silently wrong in whichever direction it differs, and a
 * measurement in a *smaller* face under-counts every entry — which is how a
 * legend wraps into a row nobody reserved for it and rides up into the x-axis.
 * This was a live defect: the measurement said 11px while the legend rendered at
 * CHART_LABEL_SIZE, under-counting every label by 4.5%.
 */
export const CHART_LABEL_FONT = `${CHART_LABEL_SIZE}px ${CHART_FONT_FAMILY}`;

export interface ChartChrome {
  /** --color-ink-2 */
  axisLabel: string;
  /** --color-surface-2 */
  gridLine: string;
  /** --color-edge */
  axisLine: string;
  /** --color-ink */
  text: string;
  /** --color-bg. The heatmaps draw their cell gaps in the page colour so the
   *  grid reads as a gap rather than a drawn line — which means a literal here
   *  puts black gridlines on a light page. */
  page: string;
}

const CHROME_BY_THEME: Record<ThemeName, ChartChrome> = {
  dark: {
    axisLabel: "#9aa0a8",
    gridLine: "#1d2026",
    axisLine: "#2a2e36",
    text: "#e8eaed",
    page: "#0f1115",
  },
  light: {
    axisLabel: "#515762",
    gridLine: "#eaecf1",
    axisLine: "#d9dce3",
    text: "#24282f",
    page: "#edeff3",
  },
};

/** Chrome shared by every chart: axis labels, gridlines, tooltip surface. */
export function chartChrome(theme: ThemeName): ChartChrome {
  return CHROME_BY_THEME[theme];
}

/**
 * Item geometry of the horizontal legend the stacked-bar charts draw.
 *
 * ProductiveHoursChart measures this legend to reserve the top margin a wrapped
 * row needs, so the numbers below are read twice: once by the `legend` option
 * ECharts lays out, and once by that estimate. They have to agree — under-count
 * the width and an unpredicted row lands on top of the x-axis labels — so they
 * are one constant rather than two sites and a comment asking for them to match.
 */
export const STACKED_BAR_LEGEND_GEOMETRY = {
  itemWidth: 14,
  itemHeight: 8,
  itemGap: 14,
} as const;

/**
 * The `legend` option for a stacked-bar chart, given its series names. An entry
 * may be an object rather than a bare name when it needs its own icon — the
 * productive-average line is drawn dashed, so its swatch has to say so.
 */
export function stackedBarLegend(
  chrome: ChartChrome,
  data: ReadonlyArray<string | { name: string; icon: string }>,
) {
  return {
    show: true,
    bottom: 4,
    left: "center",
    width: "92%",
    data,
    textStyle: { color: chrome.axisLabel, fontSize: CHART_LABEL_SIZE },
    ...STACKED_BAR_LEGEND_GEOMETRY,
  } as const;
}

/** Tooltip surface and border, mirroring --color-surface-2 / --color-edge. */
const TOOLTIP_BY_THEME: Record<ThemeName, { backgroundColor: string; borderColor: string }> = {
  dark: { backgroundColor: "#1d2026", borderColor: "#2a2e36" },
  light: { backgroundColor: "#eaecf1", borderColor: "#d9dce3" },
};

/** The one tooltip look, spread into any ECharts `tooltip` option. In-chart
 *  tooltips fire immediately: the pointer is already over a data mark the reader
 *  chose to inspect, so the dwell delay that keeps incidental UI hints (tile
 *  titles, the delta column) from flickering only gets in the way here. */
export function tooltipStyle(theme: ThemeName) {
  return {
    showDelay: 0,
    ...TOOLTIP_BY_THEME[theme],
    textStyle: { color: CHROME_BY_THEME[theme].text, fontSize: 12 },
  } as const;
}

/** Vivid data green: chart fills and liveness (--color-good-data). Anything
 *  that merely annotates (delta text, state dots) uses --color-good instead.
 *  Palette-invariant: liveness reads the same whatever palette is selected. */
const GOOD_DATA_BY_THEME: Record<ThemeName, string> = {
  dark: "#16b981",
  light: "#0a855b",
};
export function goodData(theme: ThemeName): string {
  return GOOD_DATA_BY_THEME[theme];
}

/** Annotation lines (e.g. the 7-day average): the interactive accent, not a
 *  category hue — category colors are reserved for category identity.
 *  Mirrors --color-accent. */
const ANNOTATION_BY_THEME: Record<ThemeName, string> = {
  dark: "#6ba0da",
  light: "#2a66b0",
};
export function annotation(theme: ThemeName): string {
  return ANNOTATION_BY_THEME[theme];
}

/**
 * The three near-surface fills. Each is chosen for its distance from the card it
 * sits on rather than for a hue, so each needs a counterpart per theme — a
 * single value would make AFK the darkest thing on a light page, which is the
 * opposite of what "nothing was happening" should look like.
 *
 *   bar   the uncategorized stack in a bar chart (--color-surface-3-ish)
 *   mark  gray for uncategorized/unknown items, matching the dashed-ring
 *         affordance; it has to read as a colour, not as an empty cell
 *   afk   away-from-keyboard segments on the timeline
 */
const NEAR_SURFACE_BY_THEME: Record<ThemeName, { bar: string; mark: string; afk: string }> = {
  dark: { bar: "#30343b", mark: "#5b616b", afk: "#33363d" },
  light: { bar: "#dfe2e9", mark: "#858b96", afk: "#d8dce4" },
};

export function uncategorizedBar(theme: ThemeName): string {
  return NEAR_SURFACE_BY_THEME[theme].bar;
}

export function uncategorizedMark(theme: ThemeName): string {
  return NEAR_SURFACE_BY_THEME[theme].mark;
}

export function afkFill(theme: ThemeName): string {
  return NEAR_SURFACE_BY_THEME[theme].afk;
}

/** Heatmap ramps for the DEFAULT palette on the dark theme. Live views derive
 *  ramps from the selected palette and the active theme's card surface via
 *  `metricRamps(meta.palette, meta.theme)`; this export backs tests and any
 *  default-only reference. */
export const ACTIVITY_METRIC_RAMPS = metricRamps(DEFAULT_PALETTE, "dark");

export { rampSurface };
