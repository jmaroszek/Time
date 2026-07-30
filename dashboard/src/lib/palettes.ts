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
// PROTECTED_HUE_ZONES enforced, now held per palette in palettes.test.ts).
//
// Every palette carries a `light` block: the same identities re-stepped for a
// white card. It is not decoration. The eight hue identities would survive
// unchanged — being mid-dark, they gain contrast on white (Jewel's run 2.53–4.85
// on the dark card and 3.66–7.01 on the light one) — but the two muted neutrals
// cannot. They separate from the `neutral` productivity state by being *lighter*
// than it, and that lightness is exactly what makes them vanish on white
// (2.46–2.50:1). No single value satisfies both surfaces: it would have to be
// lighter than a cool mid-grey state and dark enough to read against white at
// the same time. That is why the re-stepping exists, and why it is per theme
// rather than a tweak to the shared values.
//
// **The database stores the canonical (dark-block) hex.** The light values are a
// display transform applied on the way out — see themedSwatch / canonicalSwatch,
// and the two of them are what keeps "existing categories keep their saved
// colors" true: the saved value never changes, only how it is drawn.

import type { ActivityMetric } from "./overview";
import type { ThemeName } from "./theme";

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
  /** Light-surface re-stepping. Index-parallel with the dark `swatches` above —
   *  themedSwatch and canonicalSwatch both rely on that, so the two arrays must
   *  stay the same length and in the same order. palettes.test.ts checks it. */
  light: PaletteColors;
}

export const PALETTES: Palette[] = [
  {
    id: "slate",
    label: "Slate",
    description: "Muted, balanced colors with a calm, understated feel.",
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
    description: "Warm ambers, oranges, and roses with softer cool tones.",
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
    description: "Cool teals, blues, and violets with subdued warm tones.",
    swatches: ["#ae4388", "#2b97ef", "#05747e", "#a473ee", "#59800a", "#4d57c5", "#0ea995", "#9b4e01", "#95a8b2", "#827e8b"],
    productive: "#2e9e52",
    neutral: "#6c7680",
    unproductive: "#f05846",
    light: {
      // #667b80, not the #778993 this was drawn as: that sat at OKLCH L 0.619
      // against the light `neutral` state's 0.620 — ΔE 1.30, indistinguishable.
      // Two low-chroma greys can only be separated by lightness.
      swatches: ["#9d3479", "#367fbf", "#01646c", "#9260da", "#4d7002", "#4249af", "#109582", "#b4621e", "#667b80", "#65616d"],
      productive: "#028c43",
      neutral: "#80878f",
      unproductive: "#ac1b14",
    },
  },
  {
    id: "jewel",
    label: "Jewel",
    description: "Deep, moody jewel tones with rich saturation.",
    swatches: ["#087974", "#3584e0", "#a41b76", "#6f910d", "#5b4cb6", "#7a5b01", "#ae59c7", "#cb600a", "#9da5b4", "#877c86"],
    productive: "#0cb68b",
    neutral: "#6c7680",
    unproductive: "#f05560",
    light: {
      // #747586 for the same reason as Tide's: #7f8695 was ΔE 1.06 from the
      // light `neutral` state.
      swatches: ["#056965", "#2c74ca", "#910a66", "#628116", "#4e3da5", "#694e00", "#9e4ab7", "#b35713", "#747586", "#6a5f69"],
      productive: "#078968",
      neutral: "#80878f",
      unproductive: "#ac1828",
    },
  },
  {
    id: "terra",
    label: "Terra",
    description: "Earthy terracotta, ochre, olive, denim, and plum.",
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

const srgbToLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** OKLCH hue gives unlike palettes a common visual order. The fixed 35° start
 *  begins near orange and walks through green, teal, blue, violet, and rose;
 *  muted neutrals stay in their deliberate final two slots. */
function perceptualHue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) =>
    srgbToLinear(parseInt(hex.slice(index, index + 2), 16) / 255),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(labB, a) * 180) / Math.PI;
  return (hue - 35 + 720) % 360;
}

/**
 * The palette as the active theme draws it. Returning a `Palette` whose top-level
 * colours are already the right ones means every existing consumer of
 * `meta.palette.productive` (and the rest) is correct without knowing a theme
 * exists. `light` is carried through so the two mappers below still have both
 * blocks to work from.
 */
export function paletteForTheme(palette: Palette, theme: ThemeName): Palette {
  return theme === "light" ? { ...palette, ...palette.light } : palette;
}

/**
 * A stored category colour as the active theme should draw it.
 *
 * Index-based rather than a colour computation: the light block is hand-stepped,
 * not derived, so the only thing that can map one to the other is the slot they
 * share. A hex that is not in this palette at all — saved under a different
 * palette, or from a release that offered other swatches — is returned unchanged.
 * That is the deliberate fallback: showing a colour the user actually chose beats
 * snapping it to a neighbour we guessed at.
 */
export function themedSwatch(palette: Palette, theme: ThemeName, hex: string): string {
  if (theme !== "light") return hex;
  const blocks = swatchBlocks(palette);
  const index = blocks.canonical.findIndex(
    (swatch) => swatch.toLowerCase() === hex.toLowerCase(),
  );
  return index === -1 ? hex : blocks.light[index];
}

/**
 * The inverse, for the write path. Anything the user picks in light mode has to
 * be stored as its dark-block equivalent, or the value would stop round-tripping
 * the moment they switched themes.
 */
export function canonicalSwatch(palette: Palette, theme: ThemeName, hex: string): string {
  if (theme !== "light") return hex;
  const blocks = swatchBlocks(palette);
  const index = blocks.light.findIndex(
    (swatch) => swatch.toLowerCase() === hex.toLowerCase(),
  );
  return index === -1 ? hex : blocks.canonical[index];
}

/**
 * The two swatch blocks, resolved from the palette's *id* rather than read off
 * the object handed in.
 *
 * This is not defensiveness for its own sake. `paletteForTheme` returns a palette
 * whose top-level `swatches` are already the light block, and that themed object
 * is what lives on `meta.palette` — so a mapper reading `palette.swatches`
 * directly would be looking for a canonical value in a list of light ones, find
 * nothing, and silently return its input unchanged. Both mappers were wrong that
 * way once; resolving by id makes the result the same whichever object arrives.
 */
function swatchBlocks(palette: Palette): { canonical: string[]; light: string[] } {
  const base = PALETTES.find((candidate) => candidate.id === palette.id);
  return base
    ? { canonical: base.swatches, light: base.light.swatches }
    : { canonical: palette.swatches, light: palette.light.swatches };
}

/** Display order only. Palette array order still owns new-category assignment. */
export function previewSwatches(palette: Palette): string[] {
  return [
    ...[...palette.swatches.slice(0, 8)].sort(
      (left, right) => perceptualHue(left) - perceptualHue(right),
    ),
    ...palette.swatches.slice(8),
  ];
}

// The card surface an empty heatmap cell melts into (mirrors --color-surface).
// A parameter of the ramp rather than a constant: every calendar and rhythm ramp
// blends up from it, so pinned to the dark card an empty cell renders as a dark
// square in the middle of a light one.
const RAMP_SURFACE: Record<ThemeName, string> = {
  dark: "#16181d",
  light: "#ffffff",
};

/** The card an empty heatmap cell melts into, for callers that need the fill
 *  itself (a cell border, say) rather than a ramp. */
export function rampSurface(theme: ThemeName): string {
  return RAMP_SURFACE[theme];
}

/** Neutral "amount" peak for the tracked-time metric: a fixed blue, the same in
 *  every palette. Blue communicates volume without the productive/non-productive
 *  judgment green or red would make. Re-stepped for light, where the dark value
 *  is too pale against white to read as the top of a scale. */
const TRACKED_PEAK: Record<ThemeName, string> = {
  dark: "#59a9ef",
  light: "#2a6ab5",
};

// Keep zero flush with the card and the maximum at the full data colour, but
// bring typical nonzero cells forward. A linear blend left most heatmap cells
// much quieter than the bars even though their peaks matched.
const RAMP_BLEND_STRENGTHS = [0, 0.55, 0.82, 1];

function mix(from: string, to: string, t: number): string {
  const channels = [1, 3, 5].map((i) => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * t);
  });
  return "#" + channels.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** A perceptually front-loaded 4-stop ramp from the card surface up to `color`,
 *  so empty cells recede, typical activity remains legible, and the hottest cell
 *  still reaches the palette's exact state colour. The blend strengths are
 *  theme-independent — they are perceptual, and only the surface they start from
 *  changes. */
function rampFrom(surface: string, color: string): string[] {
  return RAMP_BLEND_STRENGTHS.map((strength) => mix(surface, color, strength));
}

/** Heatmap ramp per shaded metric, derived from the palette's state colours and
 *  the active theme's card surface. Tracked stays the neutral blue. */
export function metricRamps(
  palette: Palette,
  theme: ThemeName,
): Record<ActivityMetric, string[]> {
  const surface = RAMP_SURFACE[theme];
  return {
    tracked: rampFrom(surface, TRACKED_PEAK[theme]),
    productive: rampFrom(surface, palette.productive),
    unproductive: rampFrom(surface, palette.unproductive),
    neutral: rampFrom(surface, palette.neutral),
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
  // Colorblind: separates good from bad on the blue↔yellow axis (which
  // red-green CVD preserves) instead of the red↔green axis (which it destroys) —
  // a blue-teal "productive" against a red "unproductive". The two stay distinct
  // under protanopia/deuteranopia, where Vivid's green/red nearly merge
  // (palettes.test.ts holds both facts).
  { id: "cvd", label: "Colorblind", productive: "#048db3", unproductive: "#d02a3a",
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
