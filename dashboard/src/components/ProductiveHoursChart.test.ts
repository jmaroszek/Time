import { describe, expect, it } from "vitest";

import {
  estimateLegendRows,
  formatHoursTooltipRow,
  legendContentWidth,
  representedStacks,
} from "./ProductiveHoursChart";

describe("formatHoursTooltipRow", () => {
  it("omits a zero-hour stack segment", () => {
    expect(formatHoursTooltipRow({ marker: "●", seriesName: "Unproductive", value: 0 }, "7-day productive avg")).toEqual([]);
  });

  it("omits a stack segment that rounds to 0.0h even though it isn't a true zero", () => {
    // Stack values are rounded to hundredths (e.g. 0.03), one digit finer than
    // the tooltip's toFixed(1) display, so this must be caught too.
    expect(formatHoursTooltipRow({ marker: "●", seriesName: "Media", value: 0.03 }, "7-day productive avg")).toEqual([]);
  });

  it("keeps a non-zero stack segment", () => {
    expect(formatHoursTooltipRow({ marker: "●", seriesName: "Productive", value: 6 }, "7-day productive avg"))
      .toEqual(["●Productive: <b>6.0h</b>"]);
  });

  it("shows the average line even when it's zero", () => {
    expect(formatHoursTooltipRow({ marker: "●", seriesName: "7-day productive avg", value: 0 }, "7-day productive avg"))
      .toEqual(["●7-day productive avg: <b>0.0h</b>"]);
  });

  it("still omits the average line when it's missing", () => {
    expect(formatHoursTooltipRow({ marker: "●", seriesName: "7-day productive avg", value: "-" }, "7-day productive avg")).toEqual([]);
  });

  it("escapes user-controlled category names while keeping the marker", () => {
    expect(formatHoursTooltipRow({
      marker: '<span class="marker">●</span>',
      seriesName: 'R&D <script>alert("x")</script> & more',
      value: 1,
    }, "7-day productive avg")).toEqual(['<span class="marker">●</span>R&amp;D &lt;script&gt;alert("x")&lt;/script&gt; &amp; more: <b>1.0h</b>']);
  });
});

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
  it("subtracts a safety margin from the 92% band", () => {
    // 500 * 0.92 = 460, minus the 16px safety margin. ECharts wraps on the
    // declared width itself, so its 5px padding is not deducted here.
    expect(legendContentWidth(500)).toBe(444);
  });

  it("goes non-positive for an unmeasured container, tripping the fallback", () => {
    expect(legendContentWidth(0)).toBeLessThanOrEqual(0);
  });
});

describe("the productivity legend at the app's minimum width", () => {
  // Text widths ECharts actually renders these labels at, measured on a canvas
  // in CHART_FONT_FAMILY at CHART_LABEL_SIZE — the size the legend really
  // renders at. An earlier fixture was measured at 11px, which under-counted
  // every entry by 4.5% and made the estimate optimistic in the one direction
  // that hurts: a row nobody reserved for, riding up into the x-axis labels.
  //
  // The full row needs 386.04px: the four items (each 19px of icon plus its
  // text) and three 14px gaps.
  const RENDERED_TEXT_WIDTH: Record<string, number> = {
    Productive: 53.97,
    Neutral: 37.66,
    Unproductive: 68.7,
    "7-day productive avg": 107.71,
  };
  const measure = (text: string) => RENDERED_TEXT_WIDTH[text];
  const labels = Object.keys(RENDERED_TEXT_WIDTH);

  // Where ECharts itself wraps, measured against a real render: one row holds
  // down to a 420px chart (0.92 x 420 = 386.4, just over the 386.04 the row
  // needs) and wraps at 400px. The estimate must never claim fewer rows than
  // these, and LEGEND_WIDTH_SAFETY deliberately makes it claim more, sooner.
  it("never predicts fewer rows than ECharts actually lays out", () => {
    expect(estimateLegendRows(labels, legendContentWidth(420), measure)).toBeGreaterThanOrEqual(1);
    expect(estimateLegendRows(labels, legendContentWidth(400), measure)).toBeGreaterThanOrEqual(2);
  });

  it("predicts the second row rather than letting it overrun the x-axis", () => {
    // Under-reserving here is what let the legend ride up into the x-axis
    // labels. At 400px the row genuinely does not fit, by either measure.
    expect(estimateLegendRows(labels, legendContentWidth(400), measure)).toBe(2);
  });

  it("reserves the second row a little before ECharts needs it", () => {
    // A two-column 1000px window leaves this card's chart about 426px wide.
    // ECharts still fits one row there; the 16px safety margin means the
    // estimate reserves two. That is the harmless direction — a spare row only
    // pads the invisible top margin, where a missing one collides.
    expect(estimateLegendRows(labels, legendContentWidth(426), measure)).toBe(2);
  });

  it("settles back to a single row once the window has real room", () => {
    // 0.92 x 440 - 16 = 388.8, clear of the 386.04 the row needs.
    expect(estimateLegendRows(labels, legendContentWidth(440), measure)).toBe(1);
  });
});

describe("representedStacks", () => {
  const stack = (name: string, hours: number[]) => ({ name, color: "#000", hours });

  it("drops a state with nothing in the visible range", () => {
    const kept = representedStacks([
      stack("Productive", [6, 0, 4]),
      stack("Neutral", [0, 2, 0]),
      stack("Unproductive", [0, 0, 0]),
    ]);
    expect(kept.map((s) => s.name)).toEqual(["Productive", "Neutral"]);
  });

  it("keeps a state that shows up in only one bucket", () => {
    expect(representedStacks([stack("Unproductive", [0, 0, 0.25])])).toHaveLength(1);
  });

  it("drops a stack whose whole range rounds away to nothing drawable", () => {
    // Hours arrive rounded to hundredths, so a few stray seconds are already 0.
    expect(representedStacks([stack("Neutral", [0, 0, 0])])).toEqual([]);
  });

  it("keeps the smallest value the bars can still express", () => {
    expect(representedStacks([stack("Neutral", [0, 0.01])])).toHaveLength(1);
  });

  it("preserves the order it was given", () => {
    const kept = representedStacks([
      stack("Work", [1]),
      stack("Games", [0]),
      stack("Reading", [2]),
    ]);
    expect(kept.map((s) => s.name)).toEqual(["Work", "Reading"]);
  });
});
