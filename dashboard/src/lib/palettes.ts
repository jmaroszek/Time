// The selectable colour palettes. Each palette owns the category swatches offered
// in the picker and the three productivity-state colours; everything else in
// chartTheme.ts is palette-invariant chrome. The active palette is chosen in
// Settings (the `color_palette` setting) and resolved on meta (`meta.palette`);
// consumers read it through useMeta rather than importing fixed constants.
//
// The values are generated from first principles in OKLCH and validated for
// colourblind separation, all-pairs distinctness (no two swatches read alike —
// same-hue pairs are split by lightness), and a floor on swatch-vs-productivity
// distance (a category never reads as a productivity state — the rule the old
// PROTECTED_HUE_ZONES enforced, now held per palette in palettes.test.ts). The
// `light` block is the light-surface re-stepping for the future light theme; the
// app is dark-only today and reads the dark values.

import type { ActivityMetric } from "./overview";

export interface PaletteColors {
  /** Category swatches offered in the picker, assigned in order: the first eight
   *  are distinct hue identities (all-pairs distinct, no near-twins); the last
   *  two are muted neutrals (a warm and a cool) for system/ignored-style
   *  categories. palettes.test.ts holds that structure. */
  swatches: string[];
  productive: string;
  neutral: string;
  unproductive: string;
}

export interface Palette extends PaletteColors {
  id: string;
  label: string;
  description: string;
  /** Light-surface re-stepping, banked for the future light theme (unused today). */
  light: PaletteColors;
}

export const PALETTES: Palette[] = [
  {
    id: "slate",
    label: "Slate",
    description: "Muted and editorial — calm, sophisticated. The steadiest on either ground.",
    swatches: ["#6056b2", "#826001", "#498adc", "#a03879", "#cf6924", "#b075d2", "#769729", "#0a837e", "#9da5b0", "#947a6a"],
    productive: "#0cb68b",
    neutral: "#6c7680",
    unproductive: "#d33949",
    light: {
      swatches: ["#5248a1", "#705301", "#4081d2", "#90276a", "#bd5a09", "#965eb8", "#6d8e1b", "#036662", "#5c646e", "#9a8070"],
      productive: "#017b37",
      neutral: "#80878f",
      unproductive: "#ac1b18",
    },
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm — embers, ambers and roses lead; cool hues lean warm.",
    swatches: ["#6b8cee", "#796503", "#744dae", "#d77500", "#b21672", "#c964cc", "#879f03", "#0a908d", "#9ba6b1", "#947a6e"],
    productive: "#08b785",
    neutral: "#6c7680",
    unproductive: "#da404e",
    light: {
      swatches: ["#354faa", "#695701", "#8f68cb", "#b56103", "#c83b86", "#87248c", "#778b18", "#047f7c", "#505963", "#9b7f74"],
      productive: "#007132",
      neutral: "#80878f",
      unproductive: "#ac1825",
    },
  },
  {
    id: "tide",
    label: "Tide",
    description: "Cool — teals, blues and violets lead; warms recede.",
    swatches: ["#ae4388", "#2b97ef", "#05747e", "#a473ee", "#59800a", "#4d57c5", "#0ea995", "#9b4e01", "#95a8b2", "#827e8b"],
    productive: "#2e9e52",
    neutral: "#6c7680",
    unproductive: "#f05846",
    light: {
      swatches: ["#9d3479", "#367fbf", "#01646c", "#9260da", "#4d7002", "#4249af", "#109582", "#b4621e", "#778993", "#65616d"],
      productive: "#028c43",
      neutral: "#80878f",
      unproductive: "#ac1b14",
    },
  },
  {
    id: "jewel",
    label: "Jewel",
    description: "Deep and moody jewel tones, rich saturation.",
    swatches: ["#087974", "#3584e0", "#a41b76", "#6f910d", "#5b4cb6", "#7a5b01", "#ae59c7", "#cb600a", "#9da5b4", "#877c86"],
    productive: "#0cb68b",
    neutral: "#6c7680",
    unproductive: "#f05560",
    light: {
      swatches: ["#056965", "#2c74ca", "#910a66", "#628116", "#4e3da5", "#694e00", "#9e4ab7", "#b35713", "#7f8695", "#6a5f69"],
      productive: "#078968",
      neutral: "#80878f",
      unproductive: "#ac1828",
    },
  },
  {
    id: "terra",
    label: "Terra",
    description: "Earthen — terracotta, ochre, olive, denim, plum.",
    swatches: ["#db6395", "#5d6f03", "#9773d0", "#a34702", "#973d8c", "#b08000", "#3169a0", "#229d92", "#ba9f89", "#6f786a"],
    productive: "#49b567",
    neutral: "#6c7680",
    unproductive: "#ee5e23",
    light: {
      swatches: ["#97225b", "#718519", "#654199", "#bc5b1d", "#b458a9", "#725202", "#4584c2", "#03736b", "#8e7560", "#525b4e"],
      productive: "#047e39",
      neutral: "#80878f",
      unproductive: "#a92501",
    },
  },
];

export const DEFAULT_PALETTE_ID = "slate";

/** The stored `color_palette` id resolved to a palette, defaulting when absent or
 *  unrecognised (a value from a future release, say). */
export function resolvePalette(id: string | undefined): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0];
}

export const DEFAULT_PALETTE = resolvePalette(DEFAULT_PALETTE_ID);

// The card surface an empty heatmap cell melts into (mirrors --color-surface).
const RAMP_SURFACE = "#16181d";

/** Neutral "amount" ramp for the tracked-time metric: a fixed blue, the same in
 *  every palette. Blue communicates volume without the productive/non-productive
 *  judgment green or red would make. */
const TRACKED_RAMP = ["#16181d", "#123b5d", "#206fae", "#59a9ef"];

function mix(from: string, to: string, t: number): string {
  const channels = [1, 3, 5].map((i) => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * t);
  });
  return "#" + channels.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** A 4-stop sequential ramp from the card surface up to `color`, so an empty cell
 *  recedes into the tile and a hot one reaches the palette's own state colour. */
function rampFrom(color: string): string[] {
  return [RAMP_SURFACE, mix(RAMP_SURFACE, color, 0.3), mix(RAMP_SURFACE, color, 0.62), color];
}

/** Heatmap ramp per shaded metric, derived from the palette's state colours.
 *  Tracked stays the fixed neutral blue. */
export function metricRamps(palette: Palette): Record<ActivityMetric, string[]> {
  return {
    tracked: TRACKED_RAMP,
    productive: rampFrom(palette.productive),
    unproductive: rampFrom(palette.unproductive),
    neutral: rampFrom(palette.neutral),
  };
}

// ── Productivity-colour options ─────────────────────────────────────────────
// Candidate green/red pairs for the productivity bars, selectable in Settings.
// Each palette ships its own productive/unproductive (placed to sit clear of that
// palette's swatches, not tuned for punch); these are deliberately-designed vivid
// pairs that override whichever palette is active. "Palette default" (no
// selection) keeps the palette's own pair. Every pair here still clears the
// swatch-distinctness floor across all palettes.
export interface ProductivityOption {
  id: string;
  label: string;
  productive: string;
  unproductive: string;
  light: { productive: string; unproductive: string };
}

export const PRODUCTIVITY_OPTIONS: ProductivityOption[] = [
  // Vivid is the default (index 0). The red is matched to the green — same-ish
  // chroma so the two states carry equal weight, a clean red hue, and lightness a
  // touch above the green so it reads vivid rather than muddy.
  { id: "vivid", label: "Vivid", productive: "#04995d", unproductive: "#dc4849",
    light: { productive: "#04693f", unproductive: "#a1302d" } },
  // Colourblind-safe: separates good from bad on the blue↔yellow axis (which
  // red-green CVD preserves) instead of the red↔green axis (which it destroys) —
  // a blue-teal "productive" against a red "unproductive". The two stay distinct
  // under protanopia/deuteranopia, where Vivid's green/red nearly merge
  // (palettes.test.ts holds both facts).
  { id: "cvd", label: "Colourblind-safe", productive: "#048db3", unproductive: "#d02a3a",
    light: { productive: "#03718f", unproductive: "#b11729" } },
];

/** Set the palette's productive/unproductive (both modes) from the selected
 *  productivity option, defaulting to Vivid (index 0) when the setting is absent
 *  or unrecognised. Productivity is a global choice, not per-palette: a palette's
 *  own productive/unproductive are only a fallback and are always replaced here.
 *  Swatches and neutral are preserved. */
export function applyProductivity(palette: Palette, styleId: string | undefined): Palette {
  const option = PRODUCTIVITY_OPTIONS.find((o) => o.id === styleId) ?? PRODUCTIVITY_OPTIONS[0];
  return {
    ...palette,
    productive: option.productive,
    unproductive: option.unproductive,
    light: {
      ...palette.light,
      productive: option.light.productive,
      unproductive: option.light.unproductive,
    },
  };
}
