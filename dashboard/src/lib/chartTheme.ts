// Shared chart chrome and semantic data colors (audit VIS-001/VIS-005).
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
  backgroundColor: "#1d2026", // --color-surface-2
  borderColor: "#2a2e36", // --color-edge
  textStyle: { color: CHROME.text, fontSize: 12 },
} as const;

/** Vivid data green: chart fills and liveness (--color-good-data). Anything
 *  that merely annotates (delta text, state dots) uses --color-good instead. */
export const GOOD_DATA = "#16b981";

/** Deliberately de-emphasized non-productive bar fill. */
export const NON_PRODUCTIVE_BAR = "#3a3d44";

/** Annotation lines (e.g. the 7-day average): the interactive accent, not a
 *  category hue — category colors are reserved for category identity (VIS-003). */
export const ANNOTATION = "#6ba0da"; // --color-accent

/** Sequential heatmap ramp: green like the productive fill, with stops kept
 *  off every seed/live category color (VIS-003). */
export const HEATMAP_RAMP = ["#16181d", "#0e3a2c", "#17836a", "#4fd0a4"];

/** Gray for uncategorized/unknown items, matching the dashed-ring affordance. */
export const UNCATEGORIZED = "#5b616b";
