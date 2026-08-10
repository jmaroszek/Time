import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalSwatch,
  DEFAULT_PALETTE_ID,
  metricRamps,
  paletteForTheme,
  PALETTES,
  previewSwatches,
  PRODUCTIVITY_OPTIONS,
  resolvePalette,
  themedSwatch,
  type PaletteColors,
} from "./palettes";

// OKLab ΔE (×100): the perceptual distance the palettes were generated against.
// Kept local so the test owns its yardstick rather than trusting the generator.
const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function linrgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => s2lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
}
function oklabLin([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklab(hex: string): [number, number, number] {
  return oklabLin(linrgb(hex));
}

// Machado-Oliveira-Fernandes (2009) red-green CVD transforms at severity 1.0.
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;
function simulate([r, g, b]: [number, number, number], m: readonly (readonly number[])[]): [number, number, number] {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return [
    clamp(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    clamp(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    clamp(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}
/** Worst-case ΔE between two colours under simulated protanopia and deuteranopia. */
function cvdDeltaE(a: string, b: string): number {
  return Math.min(
    ...(["protan", "deutan"] as const).map((kind) => {
      const x = oklabLin(simulate(linrgb(a), MACHADO[kind]));
      const y = oklabLin(simulate(linrgb(b), MACHADO[kind]));
      return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
    }),
  );
}
function deltaE(a: string, b: string): number {
  const x = oklab(a);
  const y = oklab(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
function chroma(hex: string): number {
  const [, a, b] = oklab(hex);
  return Math.hypot(a, b);
}
function minAllPairs(colors: string[]): number {
  let min = Infinity;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) min = Math.min(min, deltaE(colors[i], colors[j]));
  }
  return min;
}

// WCAG contrast, for the hue swatches. These are never drawn as text —
// stateColors feeds CategoryDot, TopUsageList and TimelineChart fill blocks,
// chartTheme fills series — so the applicable floor is the 3:1 graphical-object
// one, not the 4.5:1 text floor. Light is held on the card; dark is held on the
// lighter raised surface where a swatch has its lowest contrast. The row surface
// owns dark's spread because category dots most often appear there.
const LIGHT_CARD = "#ffffff";
const DARK_THEME_CSS = readFileSync(join(__dirname, "..", "index.css"), "utf8")
  .match(/@theme\s*{([\s\S]*?)\n}/)?.[1];
function darkThemeToken(name: string): string {
  const value = DARK_THEME_CSS?.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`Missing dark theme token ${name}`);
  return value;
}
const DARK_ROW = darkThemeToken("--color-surface-2");
const DARK_RAISED = darkThemeToken("--color-surface-3");
function wcagLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function wcagContrast(a: string, b: string): number {
  const [high, low] = [wcagLuminance(a), wcagLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

const MODES: Array<[string, (palette: (typeof PALETTES)[number]) => PaletteColors]> = [
  ["dark", (palette) => palette],
  ["light", (palette) => palette.light],
];

describe("palettes", () => {
  it("makes Slate the default and falls back for missing or unknown ids", () => {
    expect(PALETTES[0].id).toBe(DEFAULT_PALETTE_ID);
    expect(resolvePalette(DEFAULT_PALETTE_ID).id).toBe(DEFAULT_PALETTE_ID);
    expect(resolvePalette(undefined)).toBe(PALETTES[0]);
    expect(resolvePalette("from-a-future-release")).toBe(PALETTES[0]);
  });

  it("gives every palette a unique id and label", () => {
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
    expect(new Set(PALETTES.map((p) => p.label)).size).toBe(PALETTES.length);
  });

  it("sorts only the preview hues and keeps the muted neutrals last", () => {
    for (const palette of PALETTES) {
      const preview = previewSwatches(palette);
      expect(new Set(preview)).toEqual(new Set(palette.swatches));
      expect(preview.slice(8)).toEqual(palette.swatches.slice(8));
      expect(palette.swatches).toHaveLength(10);
    }
  });

  for (const palette of PALETTES) {
    for (const [mode, pick] of MODES) {
      const colors = pick(palette);
      const hues = colors.swatches.slice(0, 8);
      const neutrals = colors.swatches.slice(8);
      describe(`${palette.label} · ${mode}`, () => {
        it("offers ten swatches, none repeated", () => {
          expect(colors.swatches).toHaveLength(10);
          expect(new Set(colors.swatches).size).toBe(10);
        });

        // The eight hue identities read alike to no pair, even side by side in a
        // donut — same-hue pairs are separated in lightness, not left as twins.
        // Light's floor is lower than dark's: holding the graphical-contrast
        // band (below) compresses the lightness range available to spread
        // hues across, so light trades some of that separation for staying on
        // a white card the way a category swatch — a graphic, not text —
        // should. 10.19 is the lowest any current palette (Ember) reaches.
        it("keeps the eight hue swatches perceptually distinct", () => {
          expect(minAllPairs(hues)).toBeGreaterThanOrEqual(mode === "light" ? 10 : 12);
        });

        // The two neutrals are quieter, so they sit closer than the hues — but
        // every swatch, neutrals included, stays tellable apart.
        it("keeps all ten swatches distinguishable", () => {
          expect(minAllPairs(colors.swatches)).toBeGreaterThanOrEqual(7);
        });

        // The last two are neutrals: low chroma, so they read as system/ignored
        // greys rather than another hue identity.
        it("keeps the last two swatches muted", () => {
          for (const neutral of neutrals) expect(chroma(neutral)).toBeLessThanOrEqual(0.09);
        });

        // Light only: swatches are graphics (CategoryDot, TopUsageList,
        // TimelineChart, chartTheme series), never text, so the applicable WCAG
        // floor is 3:1, not 4.5:1. The band's upper bound is what a one-sided
        // minimum could never catch — a swatch that is too heavy is a failure
        // too, which is the case the old assertion had no way to express.
        if (mode === "light") {
          it("keeps each hue swatch within the graphical-fill contrast band on the light card", () => {
            for (const hue of hues) {
              const ratio = wcagContrast(hue, LIGHT_CARD);
              expect(Math.round(ratio * 100) / 100, hue).toBeGreaterThanOrEqual(3.0);
              // Most swatches land at 3.2-4.9:1. Two sit higher by design — Tide's
              // #117881 (5.21) and Terra's #8a6400 (5.38) — nudged off a pure
              // rank-preserving re-step specifically to hold the all-pairs
              // distinctness floor; the ceiling admits them rather than the
              // typical spread so a real regression (going darker still) is
              // still caught.
              expect(Math.round(ratio * 100) / 100, hue).toBeLessThanOrEqual(5.4);
            }
          });

          // The real defect: the old slate spread was 2.06x, which is why the
          // list read as a ranking instead of eight peers. Every proposed
          // palette lands at 1.53x; the cap gives it room without regressing.
          it("keeps the eight hue swatches' contrast spread tight, so the set reads as peers", () => {
            const ratios = hues.map((hue) => wcagContrast(hue, LIGHT_CARD));
            const spread = Math.max(...ratios) / Math.min(...ratios);
            expect(spread).toBeLessThanOrEqual(1.7);
          });
        } else {
          it("keeps each hue swatch within the graphical-fill contrast band on the raised surface", () => {
            for (const hue of hues) {
              const ratio = wcagContrast(hue, DARK_RAISED);
              expect(Math.round(ratio * 100) / 100, hue).toBeGreaterThanOrEqual(3.0);
              expect(Math.round(ratio * 100) / 100, hue).toBeLessThanOrEqual(5.2);
            }
          });

          it("keeps the eight hue swatches' row contrast tight, so the set reads as peers", () => {
            const ratios = hues.map((hue) => wcagContrast(hue, DARK_ROW));
            const spread = Math.max(...ratios) / Math.min(...ratios);
            expect(spread).toBeLessThanOrEqual(1.7);
          });
        }
      });
    }

    // The rule the old PROTECTED_HUE_ZONES enforced, and the one thing the file
    // header claimed was held here without anything actually checking it: a
    // category must never read as a productivity state. Both selectable
    // productivity pairs count, not just the palette's own — a pair chosen in
    // Settings replaces the palette's, so a swatch has to clear all of them.
    //
    // Both modes, because both are drawn now. This is what caught Tide's #778993
    // and Jewel's #7f8695 sitting ΔE 1.30 and 1.06 from their own light
    // `neutral` — two low-chroma greys at the same lightness, indistinguishable.
    for (const [mode, pick] of MODES) {
      const colors = pick(palette);
      describe(`${palette.label} · ${mode} · productivity separation`, () => {
        const states = [
          colors.productive,
          colors.neutral,
          colors.unproductive,
          ...PRODUCTIVITY_OPTIONS.flatMap((option) =>
            mode === "light"
              ? [option.light.productive, option.light.unproductive]
              : [option.productive, option.unproductive],
          ),
        ];
        it("keeps every swatch clear of every productivity state", () => {
          for (const swatch of colors.swatches) {
            for (const state of states) {
              expect(
                Math.round(deltaE(swatch, state) * 100) / 100,
                `${swatch} vs ${state}`,
              ).toBeGreaterThanOrEqual(3.5);
            }
          }
        });
      });
    }
  }

  // themedSwatch and canonicalSwatch map a stored colour to its counterpart by
  // the slot the two blocks share, so the two arrays have to stay aligned. A
  // reordered or short `light` block would silently map colours to the wrong
  // identity — a category would change hue on a theme switch.
  it("keeps the light block index-parallel with the dark one, and round-trips", () => {
    for (const palette of PALETTES) {
      expect(palette.light.swatches).toHaveLength(palette.swatches.length);
      for (const [index, swatch] of palette.swatches.entries()) {
        const light = themedSwatch(palette, "light", swatch);
        expect(light).toBe(palette.light.swatches[index]);
        expect(canonicalSwatch(palette, "light", light)).toBe(swatch);
        // Dark is the canonical block, so both mappers are identities there.
        expect(themedSwatch(palette, "dark", swatch)).toBe(swatch);
        expect(canonicalSwatch(palette, "dark", swatch)).toBe(swatch);
      }
    }
  });

  // The mistake this caught in review, and the reason the mappers resolve their
  // blocks by palette id: `meta.palette` is the *themed* palette, so its
  // `swatches` are already the light block. A mapper reading that field directly
  // finds no canonical value in it and returns its input unchanged — the mapping
  // silently does nothing, in exactly the case it exists for.
  it("maps correctly when handed the themed palette, not just the raw one", () => {
    for (const palette of PALETTES) {
      const themed = paletteForTheme(palette, "light");
      for (const [index, canonical] of palette.swatches.entries()) {
        const light = palette.light.swatches[index];
        expect(themedSwatch(themed, "light", canonical)).toBe(light);
        expect(canonicalSwatch(themed, "light", light)).toBe(canonical);
      }
    }
  });

  it("maps every legacy dark generation to its current slot without rewriting stored colors", () => {
    for (const palette of PALETTES) {
      for (const generation of palette.legacyDarkSwatches ?? []) {
        expect(generation).toHaveLength(palette.swatches.length);
        for (const [index, legacy] of generation.entries()) {
          expect(themedSwatch(palette, "dark", legacy)).toBe(palette.swatches[index]);
          expect(themedSwatch(palette, "light", legacy)).toBe(palette.light.swatches[index]);
        }
      }
    }
  });

  // A colour saved under another palette, or by a release that offered different
  // swatches, has no counterpart. It must survive untouched rather than snap to
  // whatever happens to be nearby.
  it("passes through a colour the palette does not contain", () => {
    const palette = PALETTES[0];
    expect(themedSwatch(palette, "light", "#123456")).toBe("#123456");
    expect(canonicalSwatch(palette, "light", "#123456")).toBe("#123456");
  });

  it("resolves the palette's own colours to the active theme's block", () => {
    for (const palette of PALETTES) {
      expect(paletteForTheme(palette, "dark").swatches).toEqual(palette.swatches);
      const light = paletteForTheme(palette, "light");
      expect(light.swatches).toEqual(palette.light.swatches);
      expect(light.productive).toBe(palette.light.productive);
      expect(light.neutral).toBe(palette.light.neutral);
      expect(light.unproductive).toBe(palette.light.unproductive);
      // `light` is carried through, so the mappers still have both blocks.
      expect(light.light).toEqual(palette.light);
    }
  });
});

describe("metric ramps", () => {
  it("derives a 4-stop ramp per metric, all starting at the same surface fill", () => {
    const ramps = metricRamps(PALETTES[0], "dark");
    for (const ramp of Object.values(ramps)) expect(ramp).toHaveLength(4);
    expect(new Set(Object.values(ramps).map((ramp) => ramp[0])).size).toBe(1);
  });

  it("front-loads colour while preserving the surface and exact metric peaks", () => {
    const palette = PALETTES[0];
    const ramps = metricRamps(palette, "dark");
    expect(ramps.tracked[3]).toBe("#59a9ef");
    expect(ramps.productive[3]).toBe(palette.productive);
    expect(ramps.neutral[3]).toBe(palette.neutral);
    expect(ramps.unproductive[3]).toBe(palette.unproductive);

    for (const ramp of Object.values(ramps)) {
      // The first nonzero stop is already closer to the peak than the surface,
      // keeping ordinary activity from spending most of the scale near-black.
      expect(deltaE(ramp[1], ramp[3])).toBeLessThan(deltaE(ramp[1], ramp[0]));
      expect(deltaE(ramp[2], ramp[3])).toBeLessThan(deltaE(ramp[1], ramp[3]));
    }
  });
});

describe("productivity options", () => {
  it("makes Vivid the default (index 0)", () => {
    expect(PRODUCTIVITY_OPTIONS[0].id).toBe("vivid");
  });

  it("separates productive from unproductive for full-colour vision", () => {
    for (const option of PRODUCTIVITY_OPTIONS) {
      expect(deltaE(option.productive, option.unproductive)).toBeGreaterThanOrEqual(20);
      expect(deltaE(option.light.productive, option.light.unproductive)).toBeGreaterThanOrEqual(18);
    }
  });

  // The whole reason the alternate exists: Vivid's green/red nearly merge under
  // red-green colourblindness, so it ships a pair that separates on the
  // blue↔yellow axis instead and stays distinct there.
  it("keeps the colourblind-safe pair distinct under simulated CVD, where Vivid is not", () => {
    const cvd = PRODUCTIVITY_OPTIONS.find((o) => o.id === "cvd")!;
    const vivid = PRODUCTIVITY_OPTIONS.find((o) => o.id === "vivid")!;
    expect(cvdDeltaE(cvd.productive, cvd.unproductive)).toBeGreaterThanOrEqual(12);
    expect(cvdDeltaE(cvd.light.productive, cvd.light.unproductive)).toBeGreaterThanOrEqual(12);
    expect(cvdDeltaE(vivid.productive, vivid.unproductive)).toBeLessThan(8);
  });

  // Productivity bars are fills too, so the same graphical-contrast band
  // applies to their light values as to the swatches above.
  it("keeps each light productivity colour within the graphical-fill contrast band", () => {
    for (const option of PRODUCTIVITY_OPTIONS) {
      for (const color of [option.light.productive, option.light.unproductive]) {
        const ratio = wcagContrast(color, LIGHT_CARD);
        expect(Math.round(ratio * 100) / 100, color).toBeGreaterThanOrEqual(3.0);
        expect(Math.round(ratio * 100) / 100, color).toBeLessThanOrEqual(5.2);
      }
    }
  });

  it("keeps each dark productivity colour clear on the raised surface", () => {
    for (const option of PRODUCTIVITY_OPTIONS) {
      for (const color of [option.productive, option.unproductive]) {
        const ratio = wcagContrast(color, DARK_RAISED);
        expect(Math.round(ratio * 100) / 100, color).toBeGreaterThanOrEqual(3.0);
        expect(Math.round(ratio * 100) / 100, color).toBeLessThanOrEqual(5.2);
      }
    }
  });
});
