import { DEFAULT_PALETTE, metricRamps } from "./palettes";

// Palette-invariant chart chrome and semantic data colours. The category swatches
// and the three productivity-state colours are NOT here — they vary by the
// selected palette and live in palettes.ts, read through meta.palette. ECharts
// can't read CSS custom properties, so the values below live here; each is
// annotated with the index.css token it mirrors. Hex literals in components
// should route through this module, palettes.ts, or the CSS tokens — nowhere else.

/** Chrome shared by every chart: axis labels, gridlines, tooltip surface. */
export const CHROME = {
  axisLabel: "#9aa0a8", // --color-ink-2
  gridLine: "#1d2026", // --color-surface-2
  axisLine: "#2a2e36", // --color-edge
  text: "#e8eaed", // --color-ink
} as const;

/** The one tooltip look, spread into any ECharts `tooltip` option. In-chart
 *  tooltips fire immediately: the pointer is already over a data mark the reader
 *  chose to inspect, so the dwell delay that keeps incidental UI hints (tile
 *  titles, the delta column) from flickering only gets in the way here. */
export const TOOLTIP_STYLE = {
  showDelay: 0,
  backgroundColor: "#1d2026", // --color-surface-2
  borderColor: "#2a2e36", // --color-edge
  textStyle: { color: CHROME.text, fontSize: 12 },
} as const;

/** Vivid data green: chart fills and liveness (--color-good-data). Anything
 *  that merely annotates (delta text, state dots) uses --color-good instead.
 *  Palette-invariant: liveness reads the same whatever palette is selected. */
export const GOOD_DATA = "#16b981";

/** Annotation lines (e.g. the 7-day average): the interactive accent, not a
 *  category hue — category colors are reserved for category identity. */
export const ANNOTATION = "#6ba0da"; // --color-accent

/** Near-surface fill for the uncategorized stack, common to every palette. */
export const UNCATEGORIZED_BAR = "#30343b";

/** Gray for uncategorized/unknown items, matching the dashed-ring affordance. */
export const UNCATEGORIZED = "#5b616b";

/** Heatmap ramps for the DEFAULT palette. Live views derive ramps from the
 *  selected palette via `metricRamps(meta.palette)`; this export backs tests and
 *  any default-only reference. */
export const ACTIVITY_METRIC_RAMPS = metricRamps(DEFAULT_PALETTE);
