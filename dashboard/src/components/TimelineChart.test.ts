import { describe, expect, it } from "vitest";

import { formatTooltip, type TimelineSegment } from "./TimelineChart";

function segment(overrides: Partial<TimelineSegment> = {}): TimelineSegment {
  return {
    process: "afk",
    title: "idle",
    categoryName: "AFK",
    color: "#000000",
    startSec: 3600,
    endSec: 7200,
    isAfk: true,
    ...overrides,
  };
}

describe("TimelineChart AFK tooltip", () => {
  it("shows the retained website identity without showing a window title", () => {
    const tooltip = formatTooltip(
      segment({ process: "chrome.exe", domain: "youtube.com" }),
    );
    expect(tooltip).toContain("AFK (idle) · <b>youtube.com</b>");
  });

  it("shows the retained app identity when no website is available", () => {
    const tooltip = formatTooltip(
      segment({ process: "spotify.exe" }),
      { "spotify.exe": "Spotify" },
    );
    expect(tooltip).toContain("AFK (idle) · <b>Spotify</b>");
  });

  it("keeps locked or legacy identity-free AFK generic", () => {
    const tooltip = formatTooltip(segment({ title: "locked" }));
    expect(tooltip).toContain("AFK (locked)");
    expect(tooltip).not.toContain("<b>");
  });
});

describe("TimelineChart block tooltip breakdown", () => {
  const block = (count: number) =>
    segment({
      isAfk: false,
      categoryName: "Browsing",
      activeSec: 900,
      breakdown: Array.from({ length: count }, (_, i) => ({
        process: `app${i}.exe`,
        seconds: 120 - i * 10,
      })),
    });

  it("lists every app when there are three or fewer, with no remainder line", () => {
    const tooltip = formatTooltip(block(3));
    expect(tooltip).toContain("App2");
    expect(tooltip).not.toContain("other");
  });

  it("collapses apps past the third into a remainder line that carries their time", () => {
    const tooltip = formatTooltip(block(8));
    expect(tooltip).toContain("App2");
    expect(tooltip).not.toContain("App3");
    // app3..app7 = 90 + 80 + 70 + 60 + 50 = 350s; the block is 680s in all
    expect(tooltip).toContain("11m active");
    expect(tooltip).toContain("+5 others · 6m");
  });

  it("shows lines that add up to the active total", () => {
    // Truncating each of these alone would show 5 + 4 + 2 + 1 = 12m of 15m.
    const tooltip = formatTooltip(
      segment({
        isAfk: false,
        breakdown: [
          { process: "a.exe", seconds: 350 },
          { process: "b.exe", seconds: 290 },
          { process: "c.exe", seconds: 170 },
          { process: "d.exe", seconds: 50 },
          { process: "e.exe", seconds: 40 },
        ],
      }),
    );
    expect(tooltip).toContain("15m active");
    const shown = [...tooltip.matchAll(/ · (\d+)m<\/div>/g)].map((m) => Number(m[1]));
    expect(shown.reduce((a, b) => a + b, 0)).toBe(15);
  });

  it("marks an app that rounds to no minutes as under a minute", () => {
    const tooltip = formatTooltip(
      segment({
        isAfk: false,
        breakdown: [
          { process: "a.exe", seconds: 840 },
          { process: "b.exe", seconds: 40 },
          { process: "c.exe", seconds: 10 },
        ],
      }),
    );
    expect(tooltip).toContain("C · &lt;1m");
  });

  it("uses the singular for one hidden app", () => {
    expect(formatTooltip(block(4))).toContain("+1 other · 1m");
  });
});

describe("TimelineChart tooltip time", () => {
  it("lists a shared meridiem once", () => {
    const startSec = new Date(2026, 0, 1, 9, 15).getTime() / 1000;
    const endSec = new Date(2026, 0, 1, 10, 30).getTime() / 1000;

    expect(formatTooltip(segment({ startSec, endSec }))).toContain(
      "9:15–10:30am",
    );
  });

  it("lists both meridiems when the range crosses the boundary", () => {
    const startSec = new Date(2026, 0, 1, 0, 5).getTime() / 1000;
    const endSec = new Date(2026, 0, 1, 12, 30).getTime() / 1000;

    expect(formatTooltip(segment({ startSec, endSec }))).toContain(
      "12:05am–12:30pm",
    );
  });
});
