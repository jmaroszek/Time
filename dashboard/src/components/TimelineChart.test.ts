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
