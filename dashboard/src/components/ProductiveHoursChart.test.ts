import { describe, expect, it } from "vitest";

import { estimateLegendRows, legendContentWidth } from "./ProductiveHoursChart";

describe("estimateLegendRows", () => {
  // A deterministic stand-in for canvas text measurement: 10px per character.
  // With LEGEND_ITEM_WIDTH(14) + LEGEND_ICON_GAP(5), an n-char label is
  // 19 + 10n px wide, and entries are separated by LEGEND_ITEM_GAP(14).
  const measure = (text: string) => text.length * 10;

  it("returns a single row for an empty legend", () => {
    expect(estimateLegendRows([], 500, measure)).toBe(1);
  });

  it("falls back to a count-based guess before the container is measured", () => {
    // availableWidth <= 0 ignores the measurer: ceil(count / 6).
    expect(estimateLegendRows(["a", "b", "c"], 0, measure)).toBe(1);
    expect(estimateLegendRows(Array(8).fill("x"), 0, measure)).toBe(2);
    expect(estimateLegendRows(Array(13).fill("x"), -1, measure)).toBe(3);
  });

  it("keeps entries on one row when they fit", () => {
    // Three 1-char items: 29px each, +14px gaps => 29 + 43 + 43 = 115px.
    expect(estimateLegendRows(["a", "b", "c"], 120, measure)).toBe(1);
  });

  it("wraps to a new row when the next entry overflows", () => {
    // Same three items in 80px: 29, +43 => 72 (fits), +43 => 115 (overflow).
    expect(estimateLegendRows(["a", "b", "c"], 80, measure)).toBe(2);
  });

  it("packs greedily across multiple rows", () => {
    // Each item 29px, gap 14px. In 100px a row holds two (72px); a third
    // overflows. Six items => three rows.
    expect(estimateLegendRows(Array(6).fill("a"), 100, measure)).toBe(3);
  });

  it("gives an overlong single entry its own row rather than dropping it", () => {
    // First entry always seeds a row even if it exceeds the width alone.
    expect(estimateLegendRows(["a-very-long-label"], 10, measure)).toBe(1);
  });
});

describe("legendContentWidth", () => {
  it("subtracts ECharts legend padding and a safety margin from the 92% band", () => {
    // 500 * 0.92 = 460, minus 10px padding and 6px safety.
    expect(legendContentWidth(500)).toBe(444);
  });

  it("goes non-positive for an unmeasured container, tripping the fallback", () => {
    expect(legendContentWidth(0)).toBeLessThanOrEqual(0);
  });
});
