import { describe, expect, it } from "vitest";

import {
  CATEGORY_SWATCHES,
  GOOD_DATA,
  PROTECTED_HUE_ZONES,
  PRODUCTIVE_BAR,
  UNPRODUCTIVE_BAR,
} from "./chartTheme";

/** Hue in degrees, plus the saturation that decides whether hue means anything.
 *  A near-gray has a hue but no perceived color, so the zone rule skips it. */
function hsl(hex: string): { hue: number; saturation: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const sixth =
    max === red
      ? ((green - blue) / delta + 6) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return { hue: sixth * 60, saturation: delta / max };
}

function inProtectedZone(hex: string): boolean {
  const { hue, saturation } = hsl(hex);
  if (saturation < 0.25) return false;
  return PROTECTED_HUE_ZONES.some(([from, to]) => hue >= from && hue <= to);
}

describe("category swatches", () => {
  it("keeps the productivity fills inside the zones they reserve", () => {
    for (const fill of [GOOD_DATA, PRODUCTIVE_BAR, UNPRODUCTIVE_BAR]) {
      expect(inProtectedZone(fill)).toBe(true);
    }
  });

  it("offers no swatch from a protected hue zone", () => {
    const collisions = CATEGORY_SWATCHES.filter(inProtectedZone);
    expect(collisions).toEqual([]);
  });

  it("never repeats a swatch, so auto-assignment stays distinguishable", () => {
    expect(new Set(CATEGORY_SWATCHES).size).toBe(CATEGORY_SWATCHES.length);
  });
});
