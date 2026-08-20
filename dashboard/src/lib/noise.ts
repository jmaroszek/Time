// Activity Library noise filtering.
//
// A tracker records every foreground window, so the catalog fills up with
// things nobody wants to track: a site opened once for four seconds, an AMD
// driver bundle, a `.tmp` payload an installer extracted and then deleted.
// Two independent tests hide those from the list.
//
//   rare item — low lifetime time AND few lifetime sessions. Both halves matter: a 15s app
//               opened twenty times is a habit, and a single 40-minute session
//               is real work. Only the intersection is noise.
//   utility   — the name says it is a machine chore, not an application.
//               Installers can run for twenty minutes, so duration cannot
//               catch these and a name pattern has to.
//
// Filtering is a view treatment over a list. It never changes totals, KPIs, or
// anything an entity contributes to a category.
//
// Both tests apply to the Activity Library. Insights' Top Apps and Top Websites
// take the utility test only: those are rankings of what mattered, and Windows
// plumbing is not an answer at any point in a database's life — least of all on
// day one, when a fresh install's whole list is the plumbing its own installer
// woke up. The rare-item test stays out, because a short-lived entry is exactly
// what a one-day range is supposed to show.

import type { ActivityEntityKind, ActivityStatus } from "./activity";

export type NoiseMode = "off" | "one_off" | "utilities_only" | "utilities";
export type NoiseReason = "one_off" | "utility";

/**
 * The stored values, named for what they actually filter.
 *
 * `NOISE_MODE_BOTH` is the string `"utilities"`, and that is the trap these
 * constants exist to defuse: it dates from when this setting had three states
 * and that one meant the whole filter. When utilities-without-rare became
 * reachable, the newcomer took the name `utilities_only` and the wider value
 * kept the narrower-sounding one. So `"utilities"` hides rare items too, and
 * `"utilities_only"` is the one that does not.
 *
 * Reading the literal misleads reliably enough that it has already happened
 * while diagnosing a report about this very default. Renaming the stored value
 * would change the settings contract between the tracker and the dashboard, so
 * the honest names live here: compare against these, never the strings.
 */
export const NOISE_MODE_OFF = "off";
export const NOISE_MODE_RARE_ONLY = "one_off";
export const NOISE_MODE_UTILITIES_ONLY = "utilities_only";
export const NOISE_MODE_BOTH = "utilities";

export interface NoisePolicy {
  mode: NoiseMode;
  /** Upper bound (exclusive) on lifetime time for the rare-item test. */
  maxSeconds: number;
  /** Upper bound (inclusive) on lifetime session count for the rare-item test. */
  maxSessions: number;
}

/** Utilities hidden, rare items shown.
 *
 *  Hiding rare items by default cost more than it saved: a new app appears in
 *  Top Apps and not in Activity until its second session, which reads as Time
 *  losing data rather than filtering it. The author hit this on a clean install
 *  and had to check the filter control to explain his own app. Utilities are
 *  different — an installer nobody ran on purpose has no second reading. */
export const DEFAULT_NOISE_POLICY: NoisePolicy = {
  mode: NOISE_MODE_UTILITIES_ONLY,
  maxSeconds: 120,
  maxSessions: 1,
};

export function hidesRareItems(mode: NoiseMode): boolean {
  return mode === NOISE_MODE_RARE_ONLY || mode === NOISE_MODE_BOTH;
}

export function hidesUtilities(mode: NoiseMode): boolean {
  return mode === NOISE_MODE_UTILITIES_ONLY || mode === NOISE_MODE_BOTH;
}

/** The UI presents two independent switches while the database keeps one
 *  backwards-compatible value. See the mode constants above for why the "both"
 *  value is spelled `utilities`. */
export function noiseModeFor(rare: boolean, utilities: boolean): NoiseMode {
  if (rare && utilities) return NOISE_MODE_BOTH;
  if (rare) return NOISE_MODE_RARE_ONLY;
  if (utilities) return NOISE_MODE_UTILITIES_ONLY;
  return NOISE_MODE_OFF;
}

/** The fields the filter looks at — a structural subset of ActivityEntitySummary. */
export interface NoiseCandidate {
  kind: ActivityEntityKind;
  key: string;
  sourceProcesses: string[];
  seconds: number;
  sessionCount: number;
  status: ActivityStatus;
}

/** Names that describe a one-time machine chore rather than an application.
 *  Tested against the process name with any trailing `.exe` removed. */
const UTILITY_APP_PATTERNS: RegExp[] = [
  // Extracted installer payloads: antigravity.tmp, asrruefisetup(v1.0.15).tmp
  /\.tmp$/,
  // Installers, updaters, and redistributables in any casing or word position
  /setup|installer|uninstall|updater|redist|bootstrapper|webinstall/,
  // Driver and firmware bundles: amd_chipset_software_8.02.18.557
  /(^|[^a-z])(driver|drivers|chipset|firmware|bios)([^a-z]|$)/,
  // Windows plumbing that is never a thing a person "used"
  /^(msiexec|rundll32|dllhost|wusa|dism|conhost|runtimebroker|backgroundtaskhost|shellexperiencehost|applicationframehost|systemsettingsbroker)$/,
  // Build- or release-stamped drops: name-b2e8a8c5f9322b9bdc2bed64853db1
  /[0-9a-f]{16,}/,
];

/** Browser "domains" that are really a local file the browser rendered.
 *  Deliberately excludes code-ish suffixes such as .js — cytoscape.js is a
 *  site someone reads, not a file they opened. */
const LOCAL_FILE_PATTERN =
  /\.(pdf|docx?|xlsx?|pptx?|txt|rtf|csv|log|tmp|zip|rar|7z|exe|msi|png|jpe?g|gif|webp|bmp|svg|epub|mobi)$/;

function normalizedNames(candidate: UtilityNameCandidate): string[] {
  const names = [candidate.key, ...candidate.sourceProcesses];
  return names.map((name) => name.toLowerCase().replace(/\.exe$/, ""));
}

/** The fields the utility-name test alone needs. Insights ranks rows that have
 *  no session count or catalog status, and only this test applies to them. */
export type UtilityNameCandidate = Pick<NoiseCandidate, "kind" | "key" | "sourceProcesses">;

/** True when the entity's name marks it as an installer, driver, or other
 *  system chore. Exported for tests and for the Settings preview copy. */
export function isUtilityName(candidate: UtilityNameCandidate): boolean {
  if (candidate.kind === "website") return LOCAL_FILE_PATTERN.test(candidate.key.toLowerCase());
  return normalizedNames(candidate).some((name) =>
    UTILITY_APP_PATTERNS.some((pattern) => pattern.test(name)),
  );
}

/** Why this entity is noise, or null when it should stay in the catalog. */
export function classifyNoise(candidate: NoiseCandidate, policy: NoisePolicy): NoiseReason | null {
  if (policy.mode === "off") return null;
  // An explicit decision outranks every heuristic below: once a rule or an
  // assignment puts an entity in a category, the user has said it matters.
  if (candidate.status !== "uncategorized") return null;
  if (hidesUtilities(policy.mode) && isUtilityName(candidate)) return "utility";
  if (
    hidesRareItems(policy.mode)
    && candidate.seconds < policy.maxSeconds
    && candidate.sessionCount <= policy.maxSessions
  ) {
    return "one_off";
  }
  return null;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Read the policy out of the settings table, falling back per-field. */
export function noisePolicyFromSettings(settings: Record<string, string>): NoisePolicy {
  const mode = settings.activity_noise_filter;
  return {
    mode:
      mode === NOISE_MODE_OFF
      || mode === NOISE_MODE_RARE_ONLY
      || mode === NOISE_MODE_UTILITIES_ONLY
      || mode === NOISE_MODE_BOTH
        ? mode
        : DEFAULT_NOISE_POLICY.mode,
    maxSeconds: positiveNumber(settings.activity_noise_max_seconds, DEFAULT_NOISE_POLICY.maxSeconds),
    maxSessions: positiveNumber(settings.activity_noise_max_sessions, DEFAULT_NOISE_POLICY.maxSessions),
  };
}
