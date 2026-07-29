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
