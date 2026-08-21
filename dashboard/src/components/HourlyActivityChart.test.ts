import { describe, expect, it } from "vitest";

import { formatHourlyTooltipRow } from "./HourlyActivityChart";

describe("formatHourlyTooltipRow", () => {
  it("escapes user-controlled category names while keeping the ECharts marker", () => {
    expect(formatHourlyTooltipRow({
      marker: '<span class="marker">●</span>',
      seriesName: 'Design <img src=x onerror=alert(1)> & review',
      value: 1,
    })).toBe('<span class="marker">●</span>Design &lt;img src=x onerror=alert(1)&gt; &amp; review: <b>1m</b>');
  });
});
