// Which processes count as browsers — the switch that decides whether a
// session is an app or a website, and whether Website/Window rules apply.
//
// Sessions store the lowercase Win32 image name, so the setting only matches
// when it has that exact shape. Rather than make people know that, every value
// is normalized on the way in: "Chrome", "chrome", and a pasted install path
// all become chrome.exe. Mirrors normalize_browser_processes in tracker/db.py.

// Mirrors DEFAULT_SETTINGS in tracker/db.py and BOOTSTRAP_SQL in database.rs.
export const DEFAULT_BROWSER_PROCESSES =
  "chrome.exe,msedge.exe,firefox.exe,brave.exe,opera.exe,vivaldi.exe,arc.exe,chromium.exe";

/** The settings field uses the names people recognize; matching keeps the
 *  canonical executable suffix internally. Non-exe extensions stay visible. */
export function displayBrowserProcesses(raw: string): string {
  return normalizeBrowserProcesses(raw)
    .map((process) => process.replace(/\.exe$/i, ""))
    .join(", ");
}

export function normalizeBrowserProcess(raw: string): string {
  const base = raw.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  if (!base) return "";
  return base.includes(".") ? base : `${base}.exe`;
}

/** Normalized, de-duplicated, and order-preserving so the settings field reads
 *  back the way it was typed. */
export function normalizeBrowserProcesses(raw: string): string[] {
  const names = new Set<string>();
  for (const part of raw.split(",")) {
    const name = normalizeBrowserProcess(part);
    if (name) names.add(name);
  }
  return [...names];
}
