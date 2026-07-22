import { describe, expect, it } from "vitest";

import type { ActivitySource } from "./activity";
import { buildActivityExport, encodeCsv, formatLocalTimestamp } from "./activityExport";

const source: ActivitySource = {
  categories: [
    { id: 1, name: "Focus", color: "#00f", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
    { id: 2, name: "Media", color: "#f00", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  ],
  rules: [
    { id: 1, matchType: "process", pattern: "code.exe", categoryId: 1, priority: 3 },
  ],
  browserProcesses: ["chrome.exe"],
  aliases: { "code.exe": "Editor" },
  sessions: [
    { id: 1, start: 1_700_000_000, end: 1_700_000_100, process: "code.exe", title: "=private, \"draft\"", domain: null, isAfk: false },
    { id: 2, start: 1_700_000_100, end: 1_700_000_200, process: "afk", title: "idle", domain: null, isAfk: true },
    { id: 3, start: 1_700_000_200, end: 1_700_000_260, process: "chrome.exe", title: "Video", domain: "youtube.com", isAfk: false, categoryOverrideId: 2, isCorrected: true },
  ],
};

describe("Activity CSV export", () => {
  it("writes UTF-8 Excel-friendly CSV and neutralizes formulas", () => {
    const csv = encodeCsv(["name"], [["=SUM(1,2)"], ['a"b']]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"a""b"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("clips detailed sessions to the selected range and omits titles by default", () => {
    const start = 1_700_000_010;
    const end = 1_700_000_050;
    const exported = buildActivityExport("sessions", source, start, end);
    expect(exported.contents).not.toContain("window_title");
    expect(exported.contents).not.toContain("private");
    expect(exported.contents).toContain('"40"');
    expect(exported.contents).toContain(`"${formatLocalTimestamp(start)}"`);
    expect(exported.contents).toContain(`"${formatLocalTimestamp(end)}"`);
  });

  it("includes titles only by explicit request and exports correction provenance", () => {
    const exported = buildActivityExport("sessions", source, 1_700_000_000, 1_700_000_300, true);
    expect(exported.contents).toContain("window_title");
    expect(exported.contents).toContain("'=private");
    expect(exported.contents).toContain("session_override");
    expect(exported.contents).toContain('"true"');
    expect(exported.contents).toContain('"afk"');
  });

  it("summarizes active entities without adding AFK as an Activity item", () => {
    const exported = buildActivityExport("summary", source, 1_700_000_000, 1_700_000_300);
    expect(exported.contents).toContain('"Editor"');
    expect(exported.contents).toContain('"youtube.com"');
    expect(exported.contents).not.toContain('"afk"');
    expect(exported.contents).toContain("Media: 60s");
  });
});
