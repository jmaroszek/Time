// Time's one outbound request, and the rules around when it is allowed to
// happen. The request itself is made in Rust (see check_for_update in
// src-tauri/src/update.rs) so the WebView never reaches the network and the
// content-security policy stays shut; this module decides *whether* to ask and
// turns the answer into something the header control can render.

import { invoke } from "@tauri-apps/api/core";

/** Where versions up to 1.2.1 kept the time of the last check, when Time asked
 *  at most once a day. It now asks once per dashboard launch: a day's wait kept
 *  a fresh release from anyone who had already opened Time that day, and the
 *  website tells repeat checks apart by install ID instead of by rationing
 *  them. Read by nothing; only cleared. */
const LEGACY_LAST_CHECK_KEY = "time.lastUpdateCheck";

export const UPDATE_PROGRESS_EVENT = "update://progress";

export type AvailableUpdate = {
  version: string;
  notes: string | null;
};

export type UpdateProgress = {
  downloaded: number;
  total: number | null;
};

/** Absent reads as enabled. The dashboard can open the database before the
 *  tracker has backfilled a newly added default, and a row nobody has written
 *  yet must not be mistaken for someone having opted out. */
export function updateChecksEnabled(settings: Record<string, string>): boolean {
  return settings.check_updates_automatically !== "0";
}

/** The automatic check waits for the privacy screen to be answered. Time's first
 *  network request must not come before the sentence that says it makes one.
 *  How often to ask is the caller's business: once per launch. */
export function shouldCheckForUpdates(settings: Record<string, string>): boolean {
  if (!updateChecksEnabled(settings)) return false;
  return settings.privacy_onboarding_complete === "1";
}

/** Drops the once-a-day stamp an older version left behind. Harmless if it is
 *  already gone, and a store that refuses is not worth an error path. */
export function forgetLegacyUpdateCheck(): void {
  try {
    window.localStorage.removeItem(LEGACY_LAST_CHECK_KEY);
  } catch {
    // Nothing reads the key any more; leaving it costs nothing.
  }
}

/** Whole percent downloaded, or null while the endpoint has not declared a
 *  length — the control shows an indeterminate state rather than a made-up
 *  number that jumps when the real total arrives. */
export function downloadPercent(progress: UpdateProgress | null): number | null {
  if (!progress || !progress.total || progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}

/** The header control's accessible name and visible label, which are the same
 *  string: an icon-only control whose tooltip and label disagree is two
 *  controls to anyone using a screen reader. */
export function updateButtonLabel(
  update: AvailableUpdate,
  installing: boolean,
  progress: UpdateProgress | null,
): string {
  if (!installing) return `Update to ${update.version}`;
  const percent = downloadPercent(progress);
  return percent === null ? "Downloading update…" : `Downloading update… ${percent}%`;
}

/** Returns null when there is nothing to install *and* when the check could not
 *  be made at all — the Rust side collapses every failure to null on purpose.
 *  See check_for_update for why an unreachable endpoint is a non-event. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  return await invoke<AvailableUpdate | null>("check_for_update");
}

/** The check a reader asked for from Settings. Unlike the launch check it
 *  rejects when the server could not be reached, so "up to date" is only ever
 *  said when it is true. */
export async function checkForUpdateNow(): Promise<AvailableUpdate | null> {
  return await invoke<AvailableUpdate | null>("check_for_update_now");
}

/** Resolves only if the install could not be started. On success Windows exits
 *  this process from inside the installer, so nothing after the await runs. */
export async function installUpdate(): Promise<void> {
  await invoke("install_update");
}
