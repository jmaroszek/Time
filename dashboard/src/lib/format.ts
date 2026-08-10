export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
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

// Charts render dates from these tables rather than `toLocaleDateString`, whose
// output varies with the host locale and would desync a chart's axis labels
// from its tooltip. The month tables carry the form in their names because the
// two used to be spelled `MONTH_NAMES` in different files with different
// contents, which reads as correct in review and renders "Jan 5" as "January 5"
// in one view only.
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const FULL_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
export const MONTH_NAMES_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtDayLabel(d: Date): string {
  return `${DAY_NAMES[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

/** An hour of the day as a bare clock label: `9am`, `12pm`, `11pm`. */
export function fmtCompactHour(hour: number): string {
  const normalized = hour % 24;
  return `${normalized % 12 || 12}${normalized < 12 ? "am" : "pm"}`;
}

/** The one-hour bucket starting at `hour`, as `9am–10am`. */
export function fmtHourRange(hour: number): string {
  return `${fmtCompactHour(hour)}–${fmtCompactHour(hour + 1)}`;
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
 * Identity of the app *row* a process belongs to: its display name, lowercased.
 *
 * Rows group by the name the user sees, which makes an alias the merge control.
 * Aliasing a dev build and an installed build to one name totals them as one
 * app instead of two identically-labeled halves of the truth. Only the key is
 * compared — the row's label keeps the alias's own casing.
 *
 * Every per-app aggregation must key on this, including the daily series behind
 * the deltas. A map keyed by raw process against rows keyed by group silently
 * misses, and a miss reads as "no time last period" rather than failing.
 */
export function appGroupKey(process: string, aliases?: Record<string, string>): string {
  return cleanProcessName(process, aliases).toLowerCase();
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
