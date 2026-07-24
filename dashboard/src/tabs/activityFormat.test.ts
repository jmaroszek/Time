import { describe, expect, it } from "vitest";

import { formatLastSeen } from "./ActivityTab";

/** Boundaries are calendar dates, not elapsed hours: 00:30 and 23:30 on the
 *  same date are both "today", and 23:30 last night is "Yesterday" even though
 *  it is an hour ago. Built from local wall-clock parts so the assertions hold
 *  in every timezone CI runs the suite under. */
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

const sec = (date: Date) => date.getTime() / 1000;

describe("formatLastSeen", () => {
  const now = at(2026, 7, 24, 9, 37);

  it("gives the time of day for anything seen today", () => {
    expect(formatLastSeen(sec(at(2026, 7, 24, 0, 30)), now)).toMatch(/^Today, /);
    expect(formatLastSeen(sec(at(2026, 7, 24, 9, 12)), now)).toMatch(/^Today, /);
  });

  it("names yesterday rather than making the reader work out the date", () => {
    expect(formatLastSeen(sec(at(2026, 7, 23, 23, 30)), now)).toBe("Yesterday");
    expect(formatLastSeen(sec(at(2026, 7, 23, 0, 5)), now)).toBe("Yesterday");
  });

  it("falls back to the date once a name would stop being clearer", () => {
    expect(formatLastSeen(sec(at(2026, 7, 22, 16, 0)), now)).toMatch(/22/);
    expect(formatLastSeen(sec(at(2026, 1, 3, 16, 0)), now)).toMatch(/2026/);
  });

  it("treats a live session's end as today rather than the future", () => {
    expect(formatLastSeen(sec(at(2026, 7, 24, 23, 59)), now)).toMatch(/^Today, /);
  });
});
