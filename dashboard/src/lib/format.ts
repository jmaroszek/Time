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
  const d = new Date(unixSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
