// Which of the two themes is on screen, and how the stored preference resolves
// to it. The values themselves live in index.css (CSS) and chartTheme.ts (the
// mirror the canvas charts need); this module owns only the choice.
//
// Resolution is deliberately separate from the media query that feeds it, so it
// is a pure function the tests can drive without a matchMedia stub.

export type ThemeName = "dark" | "light";

/** The stored `theme` setting. "system" follows the OS. */
export type ThemePreference = ThemeName | "system";

/** New installs follow the OS so a light-mode user never gets a dark first run.
 *  Mirrored in DEFAULT_SETTINGS (tracker/db.py) and BOOTSTRAP_SQL
 *  (src-tauri/src/database.rs) — see the note on settings defaults in AGENTS.md. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

export const THEME_PREFERENCES: ThemePreference[] = ["dark", "light", "system"];

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

/** The stored value, defaulting when absent or unrecognised — a value written by
 *  a future release included, which is why this never throws. */
export function resolveThemePreference(raw: string | undefined): ThemePreference {
  return raw === "dark" || raw === "light" || raw === "system"
    ? raw
    : DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeName {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
