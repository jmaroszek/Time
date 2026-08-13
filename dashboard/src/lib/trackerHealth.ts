// Whether the tracker is doing what the reader has asked of it.
//
// Two thresholds, deliberately far apart. The tracker heartbeats every 15s by
// default, so a Settings dot that a reader is actively looking at can afford to
// call anything past 8s "not detected" — they are watching it, and a stale dot
// that corrects itself a second later costs nothing.
//
// A warning that follows the reader onto every tab cannot be that twitchy. It
// interrupts, so it has to be right, and one missed heartbeat is not evidence
// of anything. TRACKER_ALERT_STALE_SECONDS is eight intervals: long enough that
// a machine waking from sleep or a busy moment cannot trip it, short enough that
// a tracker which died after a reboot is reported the next time Time is opened
// rather than a day later.

import { trackingScheduleState } from "./trackingSchedule";

/** "Live right now", for a status dot under the reader's eye. */
export const TRACKER_LIVE_STALE_SECONDS = 8;

/** "Something is wrong", for a warning that follows the reader. */
export const TRACKER_ALERT_STALE_SECONDS = 120;

export interface TrackerAlertInput {
  /** Seconds since the tracker last checked in; null when it never has. */
  heartbeatAgeSec: number | null;
  settings: Record<string, string>;
  nowSec: number;
}

/**
 * True when recording is supposed to be happening and is not.
 *
 * Every silence with a reason the reader already knows about is excluded, and
 * that exclusion is the whole point: a warning that also fires for a deliberate
 * pause teaches people to ignore it, which costs exactly the one case it exists
 * for. Paused, outside scheduled hours, and consent withdrawn are all states the
 * reader chose and Settings already reports.
 */
export function trackerNeedsAttention(
  { heartbeatAgeSec, settings, nowSec }: TrackerAlertInput,
  staleAfterSec: number = TRACKER_ALERT_STALE_SECONDS,
): boolean {
  if (settings.recording_consent !== "1") return false;
  const pausedUntil = Number(settings.tracking_paused_until) || 0;
  if (settings.tracking_paused === "1" || pausedUntil > nowSec) return false;
  const schedule = trackingScheduleState(settings, new Date(nowSec * 1000));
  if (schedule.enabled && !schedule.recordingAllowed) return false;
  // Null means the tracker has never checked in at all. That is the strongest
  // possible version of this signal, not a reason to stay quiet.
  if (heartbeatAgeSec === null) return true;
  return heartbeatAgeSec >= staleAfterSec;
}
