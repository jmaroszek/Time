// Time's one outbound request, and the rules around when it is allowed to
// happen. The request itself is made in Rust (see check_for_update in
// src-tauri/src/lib.rs) so the WebView never reaches the network and the
// content-security policy stays shut; this module decides *whether* to ask and
// turns the answer into something the header control can render.

import { invoke } from "@tauri-apps/api/core";

/** How long a completed check stays good. Time asks once per launch and then
 *  not again for a day: a version file that changes a few times a year does not
 *  reward polling, and every request is one more line in somebody's log. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Dashboard-local, deliberately not a settings row. The shared database is the
 *  contract between the tracker and the dashboard; when Time last looked at a
 *  web address is neither half's business. */
export const LAST_UPDATE_CHECK_KEY = "time.lastUpdateCheck";

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
 *  network request must not come before the sentence that says it makes one. */
export function shouldCheckForUpdates(
  settings: Record<string, string>,
  lastCheckedMs: number | null,
  nowMs: number,
): boolean {
  if (!updateChecksEnabled(settings)) return false;
  if (settings.privacy_onboarding_complete !== "1") return false;
  if (lastCheckedMs === null) return true;
  // A clock that moved backwards — a timezone change, an NTP correction, a
  // laptop that woke up in another country — must not park the next check a
  // full day in the future.
  if (lastCheckedMs > nowMs) return true;
  return nowMs - lastCheckedMs >= UPDATE_CHECK_INTERVAL_MS;
}

export function readLastUpdateCheck(): number | null {
  const raw = window.localStorage.getItem(LAST_UPDATE_CHECK_KEY);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function writeLastUpdateCheck(nowMs: number): void {
  try {
    window.localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(nowMs));
  } catch {
    // A full or disabled store costs one extra request next launch, which is
    // not worth an error path.
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

/** Resolves only if the install could not be started. On success Windows exits
 *  this process from inside the installer, so nothing after the await runs. */
export async function installUpdate(): Promise<void> {
  await invoke("install_update");
}
