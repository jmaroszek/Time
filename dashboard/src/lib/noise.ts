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
// Filtering is a view treatment over the catalog list. It never changes totals,
// Insights, or anything an entity contributes to a category.

import type { ActivityEntityKind, ActivityStatus } from "./activity";

export type NoiseMode = "off" | "one_off" | "utilities";
export type NoiseReason = "one_off" | "utility";

export interface NoisePolicy {
  mode: NoiseMode;
  /** Upper bound (exclusive) on lifetime time for the rare-item test. */
  maxSeconds: number;
  /** Upper bound (inclusive) on lifetime session count for the rare-item test. */
  maxSessions: number;
}

export const DEFAULT_NOISE_POLICY: NoisePolicy = {
  mode: "utilities",
  maxSeconds: 120,
  maxSessions: 3,
};

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

function normalizedNames(candidate: NoiseCandidate): string[] {
  const names = [candidate.key, ...candidate.sourceProcesses];
  return names.map((name) => name.toLowerCase().replace(/\.exe$/, ""));
}

/** True when the entity's name marks it as an installer, driver, or other
 *  system chore. Exported for tests and for the Settings preview copy. */
export function isUtilityName(candidate: NoiseCandidate): boolean {
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
  if (policy.mode === "utilities" && isUtilityName(candidate)) return "utility";
  return candidate.seconds < policy.maxSeconds && candidate.sessionCount <= policy.maxSessions
    ? "one_off"
    : null;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Read the policy out of the settings table, falling back per-field. */
export function noisePolicyFromSettings(settings: Record<string, string>): NoisePolicy {
  const mode = settings.activity_noise_filter;
  return {
    mode: mode === "off" || mode === "one_off" || mode === "utilities" ? mode : DEFAULT_NOISE_POLICY.mode,
    maxSeconds: positiveNumber(settings.activity_noise_max_seconds, DEFAULT_NOISE_POLICY.maxSeconds),
    maxSessions: positiveNumber(settings.activity_noise_max_sessions, DEFAULT_NOISE_POLICY.maxSessions),
  };
}
