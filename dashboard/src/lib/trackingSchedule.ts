export const DEFAULT_TRACKING_SCHEDULE_DAYS = "0,1,2,3,4";
export const DEFAULT_TRACKING_SCHEDULE_START_MINUTE = 9 * 60;
export const DEFAULT_TRACKING_SCHEDULE_END_MINUTE = 17 * 60;

export interface TrackingScheduleState {
  enabled: boolean;
  valid: boolean;
  recordingAllowed: boolean;
  currentWindowStart: Date | null;
  nextStart: Date | null;
}

function parseMinute(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value < 24 * 60 ? value : fallback;
}

export function parseTrackingScheduleDays(raw: string | undefined): number[] {
  return [...new Set((raw ?? "").split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => Number(token))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b);
}

function localDateAtMinute(day: Date, minute: number): Date {
  const result = new Date(day);
  result.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return result;
}

function mondayWeekday(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function trackingScheduleState(
  settings: Record<string, string>,
  now = new Date(),
): TrackingScheduleState {
  if (settings.tracking_schedule_enabled !== "1") {
    return {
      enabled: false,
      valid: true,
      recordingAllowed: true,
      currentWindowStart: null,
      nextStart: null,
    };
  }

  const days = new Set(parseTrackingScheduleDays(
    settings.tracking_schedule_days ?? DEFAULT_TRACKING_SCHEDULE_DAYS,
  ));
  const start = parseMinute(
    settings.tracking_schedule_start_minute,
    DEFAULT_TRACKING_SCHEDULE_START_MINUTE,
  );
  const end = parseMinute(
    settings.tracking_schedule_end_minute,
    DEFAULT_TRACKING_SCHEDULE_END_MINUTE,
  );
  if (days.size === 0 || start === end) {
    return {
      enabled: true,
      valid: false,
      recordingAllowed: false,
      currentWindowStart: null,
      nextStart: null,
    };
  }

  const secondOfDay = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
    + now.getMilliseconds() / 1_000;
  const weekday = mondayWeekday(now);
  let currentWindowStart: Date | null = null;
  if (start < end) {
    if (days.has(weekday) && start * 60 <= secondOfDay && secondOfDay < end * 60) {
      currentWindowStart = localDateAtMinute(now, start);
    }
  } else if (days.has(weekday) && secondOfDay >= start * 60) {
    currentWindowStart = localDateAtMinute(now, start);
  } else if (days.has((weekday + 6) % 7) && secondOfDay < end * 60) {
    const previousDay = new Date(now);
    previousDay.setDate(previousDay.getDate() - 1);
    currentWindowStart = localDateAtMinute(previousDay, start);
  }

  let nextStart: Date | null = null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    if (!days.has(mondayWeekday(day))) continue;
    const candidate = localDateAtMinute(day, start);
    if (candidate.getTime() > now.getTime()) {
      nextStart = candidate;
      break;
    }
  }

  return {
    enabled: true,
    valid: true,
    recordingAllowed: currentWindowStart !== null,
    currentWindowStart,
    nextStart,
  };
}

export function scheduleMinuteToInput(raw: string | undefined, fallback: number): string {
  const minute = parseMinute(raw, fallback);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function scheduleInputToMinute(raw: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatScheduleResume(date: Date): string {
  return date.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
