// Date-range logic: week starts per setting (default Sunday), ranges are
// half-open [start, end), "this week" runs from week start through end of
// today, and day counts are calendar days (DST-safe via Date component
// arithmetic, never ms addition).

export type WeekStart = "Sunday" | "Monday";
export type Preset = "today" | "last7" | "last14" | "last30" | "last90" | "last365";

export interface Range {
  start: Date;
  end: Date; // exclusive
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function startOfWeek(d: Date, weekStart: WeekStart = "Sunday"): Date {
  const startIdx = weekStart === "Monday" ? 1 : 0;
  const delta = (d.getDay() - startIdx + 7) % 7;
  return addDays(startOfDay(d), -delta);
}

/**
 * Rolling windows ending today (inclusive). The Overview tab is "recent
 * activity"; week-aligned and longer horizons live on the Trends tab.
 */
export function rangeForPreset(preset: Preset, now: Date = new Date()): Range {
  const today = startOfDay(now);
  const end = addDays(today, 1);
  switch (preset) {
    case "today":
      return { start: today, end };
    case "last7":
      return { start: addDays(today, -6), end };
    case "last14":
      return { start: addDays(today, -13), end };
    case "last30":
      return { start: addDays(today, -29), end };
    case "last90":
      return { start: addDays(today, -89), end };
    case "last365":
      return { start: addDays(today, -364), end };
  }
}

export function calendarDays(r: Range): number {
  const days = Math.round((r.end.getTime() - r.start.getTime()) / 86_400_000);
  return Math.max(days, 1);
}

/** The equal-length period immediately before `r` (for delta comparisons). */
export function previousRange(r: Range): Range {
  return { start: addDays(r.start, -calendarDays(r)), end: r.start };
}

/** Local midnights of every day in the range, in order. */
export function listDays(r: Range): Date[] {
  const out: Date[] = [];
  for (let d = startOfDay(r.start); d < r.end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseDateInput(value: string): Date | null {
  // Accepts YYYY-MM-DD (native date input format).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
