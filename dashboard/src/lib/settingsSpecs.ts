// How Settings bounds and displays the preferences it edits. `SPECS` is half of
// a cross-runtime contract: the tracker separately clamps what it consumes in
// tracker/db.py get_settings, and scripts/tests/test_settings_range_parity.py
// holds the two together.

import { displayBrowserProcesses } from "./browsers";
import type { NoiseMode } from "./noise";

export interface NumericSpec {
  key: string;
  min: number;
  max: number;
  scale: number;
  step?: number;
}

// UI clamp ranges. The tracker separately clamps what it consumes in
// tracker/db.py get_settings — keep the two in sight of each other.
export const SPECS = {
  goal: { key: "weekly_goal_hours", min: 0, max: 100, scale: 1 },
  minimum: { key: "min_app_seconds_per_day", min: 0, max: 30, scale: 60 },
  start: { key: "day_start_hour", min: 0, max: 23, scale: 1 },
  end: { key: "day_end_hour", min: 1, max: 24, scale: 1 },
  idle: { key: "idle_threshold_seconds", min: 1, max: 60, scale: 60 },
  focus: { key: "focus_chain_max_gap_seconds", min: 0, max: 30, scale: 60 },
  breakReminder: { key: "break_reminder_seconds", min: 15, max: 180, scale: 60, step: 5 },
  noiseTime: { key: "activity_noise_max_seconds", min: 0, max: 30, scale: 60, step: 0.5 },
  noiseSessions: { key: "activity_noise_max_sessions", min: 1, max: 20, scale: 1 },
} satisfies Record<string, NumericSpec>;
const SPECS_BY_KEY = new Map(
  Object.values(SPECS).map((spec) => [spec.key, spec]),
);

export function displayValue(spec: NumericSpec, raw: string | undefined): string {
  const value = Number(raw);
  return Number.isFinite(value) ? String(Math.round((value / spec.scale) * 100) / 100) : "";
}

/** The text a settings field starts from: a numeric setting in its displayed
 *  unit, the browser list in its readable form, anything else as stored. */
export function settingDraftValue(
  key: string,
  settings: Record<string, string>,
): string {
  const spec = SPECS_BY_KEY.get(key);
  if (spec) return displayValue(spec, settings[key]);
  if (key === "browser_processes") {
    return displayBrowserProcesses(settings[key] ?? "");
  }
  return settings[key] ?? "";
}

/** Split rather than one formatted string, so the hour renders in the same
 *  bright weight as every other stepper's value and "am"/"pm" renders in the
 *  same muted weight as every other stepper's unit — matching "20 hrs" and
 *  "3 min" instead of standing out as the one all-bright value in the section. */
export function clockHour(value: number): { hour: string; meridiem: "am" | "pm" } {
  const normalized = value % 24;
  return { hour: String(normalized % 12 || 12), meridiem: normalized < 12 ? "am" : "pm" };
}

export function resolvedNoiseMode(raw: string | undefined): NoiseMode {
  return raw === "off"
    || raw === "one_off"
    || raw === "utilities_only"
    || raw === "utilities"
    ? raw
    : "utilities";
}
