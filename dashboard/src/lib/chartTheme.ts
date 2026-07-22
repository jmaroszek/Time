import type { ActivityMetric } from "./overview";

// Shared chart chrome and semantic data colors.
// ECharts can't read CSS custom properties, so the values live here; each is
// annotated with the index.css token it mirrors. Hex literals in components
// should route through this module or the CSS tokens — nowhere else.

/** Chrome shared by every chart: axis labels, gridlines, tooltip surface. */
export const CHROME = {
  axisLabel: "#9aa0a8", // --color-ink-2
  gridLine: "#1d2026", // --color-surface-2
  axisLine: "#2a2e36", // --color-edge
  text: "#e8eaed", // --color-ink
} as const;

/** The one tooltip look, spread into any ECharts `tooltip` option. */
export const TOOLTIP_STYLE = {
  showDelay: 500,
  backgroundColor: "#1d2026", // --color-surface-2
  borderColor: "#2a2e36", // --color-edge
  textStyle: { color: CHROME.text, fontSize: 12 },
} as const;

/** Vivid data green: chart fills and liveness (--color-good-data). Anything
 *  that merely annotates (delta text, state dots) uses --color-good instead. */
export const GOOD_DATA = "#16b981";

/** Three-way productivity fills used when the chart exposes the taxonomy
 *  instead of collapsing everything outside productive into one stack. */
export const PRODUCTIVE_BAR = "#1d9e75";
export const NEUTRAL_BAR = "#4b5059";
/** Category-palette red-orange, balanced against PRODUCTIVE_BAR rather than
 *  the quieter --color-bad annotation red. */
export const UNPRODUCTIVE_BAR = "#d85a30";
export const UNCATEGORIZED_BAR = "#30343b";

/** Annotation lines (e.g. the 7-day average): the interactive accent, not a
 *  category hue — category colors are reserved for category identity. */
export const ANNOTATION = "#6ba0da"; // --color-accent

/** Sequential heatmap ramp: green like the productive fill, with stops kept
 *  off every seed/live category color, for the same reason. */
export const HEATMAP_RAMP = ["#16181d", "#0e3a2c", "#17836a", "#4fd0a4"];

/** Neutral activity intensity for tracked-time views. Blue communicates
 *  amount without making the productive/non-productive judgment of green. */
export const ACTIVITY_HEATMAP_RAMP = ["#16181d", "#123b5d", "#206fae", "#59a9ef"];

/** Red-orange like UNPRODUCTIVE_BAR, shifted off it at every stop so intensity
 *  never reads as a category identity. */
export const UNPRODUCTIVE_HEATMAP_RAMP = ["#16181d", "#4a2013", "#a2451f", "#e87c4d"];

/** Gray like NEUTRAL_BAR. The top stop stays below CHROME.axisLabel so a hot
 *  cell never reads as chrome or text; that ceiling makes this the lowest
 *  contrast of the ramps, which is the cost of gray on a dark surface. */
export const NEUTRAL_HEATMAP_RAMP = ["#16181d", "#2b2f37", "#474d57", "#6b727e"];

/** Ramp per shaded metric. Type-only import: this module stays free of
 *  runtime dependencies on the data layer. */
export const ACTIVITY_METRIC_RAMPS: Record<ActivityMetric, string[]> = {
  tracked: ACTIVITY_HEATMAP_RAMP,
  productive: HEATMAP_RAMP,
  unproductive: UNPRODUCTIVE_HEATMAP_RAMP,
  neutral: NEUTRAL_HEATMAP_RAMP,
};

/** Gray for uncategorized/unknown items, matching the dashed-ring affordance. */
export const UNCATEGORIZED = "#5b616b";

/** Hue arcs (degrees) that productivity owns. A category tinted from one of
 *  these renders in charts with the hue that elsewhere means productive or
 *  unproductive — one pixel color, two meanings depending on the chart. */
export const PROTECTED_HUE_ZONES: ReadonlyArray<readonly [number, number]> = [
  [150, 165], // productive green: GOOD_DATA, PRODUCTIVE_BAR, --color-good
  [10, 25], // unproductive red-orange: UNPRODUCTIVE_BAR
];

/** Colors offered when a category is created or recolored, assigned in order.
 *  Every entry stays clear of PROTECTED_HUE_ZONES — chartTheme.ts already keeps
 *  its heatmap ramps off the category hues for the same reason, and
 *  chartTheme.test.ts holds this list to the rule. */
export const CATEGORY_SWATCHES = [
  "#9c8ff0", // violet
  "#2f6fc0", // blue
  "#56c8d8", // cyan
  "#e0a53a", // amber
  "#e75fa0", // magenta
  "#b06fd8", // orchid
  "#8fbf4a", // lime
  "#c7c157", // yellow
  "#b08a5e", // warm brown
  "#828994", // gray
];
