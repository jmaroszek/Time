import { describe, expect, it } from "vitest";

import {
  DEFAULT_PALETTE_ID,
  metricRamps,
  PALETTES,
  PRODUCTIVITY_OPTIONS,
  resolvePalette,
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
        it("keeps the eight hue swatches perceptually distinct", () => {
          expect(minAllPairs(hues)).toBeGreaterThanOrEqual(12);
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
      });
    }
  }
});

describe("metric ramps", () => {
  it("derives a 4-stop ramp per metric, all starting at the same surface fill", () => {
    const ramps = metricRamps(PALETTES[0]);
    for (const ramp of Object.values(ramps)) expect(ramp).toHaveLength(4);
    expect(new Set(Object.values(ramps).map((ramp) => ramp[0])).size).toBe(1);
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
});
