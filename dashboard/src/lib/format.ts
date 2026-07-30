export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtHours(seconds: number, decimals = 1): string {
  return (seconds / 3600).toFixed(decimals);
}

export function fmtPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function fmtClock(unixSeconds: number): string {
  const { time, meridiem } = clockParts(unixSeconds);
  return `${time}${meridiem}`;
}

export function fmtClockRange(startUnixSeconds: number, endUnixSeconds: number): string {
  const start = clockParts(startUnixSeconds);
  const end = clockParts(endUnixSeconds);
  if (start.meridiem === end.meridiem) {
    return `${start.time}–${end.time}${end.meridiem}`;
  }
  return `${start.time}${start.meridiem}–${end.time}${end.meridiem}`;
}

function clockParts(unixSeconds: number): { time: string; meridiem: "am" | "pm" } {
  const d = new Date(unixSeconds * 1000);
  const hour = d.getHours();
  const displayHour = hour % 12 || 12;
  const meridiem = hour < 12 ? "am" : "pm";
  return {
    time: `${displayHour}:${String(d.getMinutes()).padStart(2, "0")}`,
    meridiem,
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtDayLabel(d: Date): string {
  return `${DAY_NAMES[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtShortDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Display name for a process. A user alias wins; otherwise use a mechanical,
 * non-opinionated transform. Production code never guesses app identities.
 */
export function cleanProcessName(process: string, aliases?: Record<string, string>): string {
  const key = process.toLowerCase();
  const user = aliases?.[key];
  if (user) return user;
  const base = process.replace(/\.exe$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Display name for a domain. A user alias (keyed by the lowercased domain)
 * wins; otherwise the domain is shown as-is — it's already readable, so unlike
 * a process name there's no fallback transform. The raw domain should still be
 * shown on hover.
 */
export function cleanDomainName(domain: string, aliases?: Record<string, string>): string {
  return aliases?.[domain.toLowerCase()] ?? domain;
}
