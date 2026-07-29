import { describe, expect, it } from "vitest";

import {
  activityDetailMode,
  activityRowAccessibleLabel,
  activitySummaryColumns,
  layoutClass,
  rhythmHourInterval,
  timelineHourInterval,
} from "./responsive";

describe("responsive layout contracts", () => {
  it("classifies the exact layout boundaries", () => {
    expect(layoutClass(500)).toBe("compact");
    expect(layoutClass(639)).toBe("compact");
    expect(layoutClass(640)).toBe("medium");
    expect(layoutClass(1007)).toBe("medium");
    expect(layoutClass(1008)).toBe("large");
    expect(layoutClass(1831)).toBe("large");
    expect(layoutClass(1832)).toBe("wide-detail");
  });

  it("uses drill-in details until there is a non-overlapping outboard margin", () => {
    expect(activityDetailMode(1831)).toBe("drill-in");
    expect(activityDetailMode(1832)).toBe("outboard");
  });

  it("removes only comparison and recurrence columns below 768px", () => {
    expect(activitySummaryColumns(767)).toEqual(["name", "time", "lastSeen"]);
    expect(activitySummaryColumns(768)).toEqual([
      "name",
      "comparison",
      "time",
      "days",
      "lastSeen",
    ]);
  });

  it("keeps compact-hidden values in the row's accessible summary", () => {
    expect(activityRowAccessibleLabel({
      name: "Visual Studio Code",
      time: "7h 10m",
      comparison: "43% of recorded time in range",
      daysSeen: 5,
      lastSeen: "Today, 8:07 AM",
      action: "Open app details",
    })).toBe(
      "Visual Studio Code — 7h 10m — 43% of recorded time in range — 5 days seen — last seen Today, 8:07 AM — Open app details",
    );
  });

  it("reduces chart labels as effective width narrows", () => {
    expect(timelineHourInterval(639)).toBe(6);
    expect(timelineHourInterval(640)).toBe(3);
    expect(rhythmHourInterval(639)).toBe(4);
    expect(rhythmHourInterval(640)).toBe(2);
    expect(rhythmHourInterval(1008)).toBe(1);
  });
});
