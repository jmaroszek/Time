import { describe, expect, it } from "vitest";

import {
  bannerFor,
  OFF_SCHEDULE_DISMISSED_KEY,
  readerIsNew,
  RECORDING_OFF_DISMISSED_KEY,
  recordingState,
  TRACKER_ALERT_STALE_SECONDS,
  trackerNeedsAttention,
  WELCOME_DISMISSED_KEY,
  WELCOME_MAX_HISTORY_DAYS,
  type RecordingState,
} from "./trackerHealth";

const NOW = 1_800_000_000;
const recording = { recording_consent: "1" };
const DAY = 86_400;

/** A schedule covering Monday-Friday 09:00-17:00. */
const workWeek = {
  tracking_schedule_enabled: "1",
  tracking_schedule_days: "1,2,3,4,5",
  tracking_schedule_start_minute: "540",
  tracking_schedule_end_minute: "1020",
};

describe("trackerNeedsAttention", () => {
  it("reports a tracker that stopped answering while recording is on", () => {
    expect(
      trackerNeedsAttention({
        heartbeatAgeSec: TRACKER_ALERT_STALE_SECONDS + 1,
        settings: recording,
        nowSec: NOW,
      }),
    ).toBe(true);
  });

  it("reports a tracker that has never checked in at all", () => {
    expect(
      trackerNeedsAttention({ heartbeatAgeSec: null, settings: recording, nowSec: NOW }),
    ).toBe(true);
  });

  it("tolerates a few missed heartbeats", () => {
    // The tracker beats every 15s by default. One skipped beat, or a machine
    // busy coming back from sleep, must not raise an alarm the reader then
    // learns to ignore.
    expect(
      trackerNeedsAttention({ heartbeatAgeSec: 45, settings: recording, nowSec: NOW }),
    ).toBe(false);
  });

  it("stays silent when the reader turned recording off", () => {
    expect(
      trackerNeedsAttention({
        heartbeatAgeSec: null,
        settings: { recording_consent: "0" },
        nowSec: NOW,
      }),
    ).toBe(false);
  });

  it("stays silent while tracking is paused", () => {
    expect(
      trackerNeedsAttention({
        heartbeatAgeSec: 10_000,
        settings: { ...recording, tracking_paused: "1" },
        nowSec: NOW,
      }),
    ).toBe(false);
  });

  it("stays silent until a timed pause has expired", () => {
    const paused = { ...recording, tracking_paused_until: String(NOW + 600) };
    expect(
      trackerNeedsAttention({ heartbeatAgeSec: 10_000, settings: paused, nowSec: NOW }),
    ).toBe(false);
    // Once the pause is behind us the silence is no longer explained.
    expect(
      trackerNeedsAttention({ heartbeatAgeSec: 10_000, settings: paused, nowSec: NOW + 601 }),
    ).toBe(true);
  });

  it("stays silent outside scheduled recording hours", () => {
    // Sunday 00:00 local, with a schedule covering Monday-Friday 09:00-17:00.
    const sundayMidnight = new Date(2026, 7, 9, 0, 0, 0).getTime() / 1000;
    expect(
      trackerNeedsAttention({
        heartbeatAgeSec: 10_000,
        settings: { ...recording, ...workWeek },
        nowSec: sundayMidnight,
      }),
    ).toBe(false);
  });
});

describe("recordingState", () => {
  const resolve = (
    settings: Record<string, string>,
    heartbeatAgeSec: number | null,
    extra: {
      totalSessionCount?: number;
      starting?: boolean;
      nowSec?: number;
      launchGrace?: boolean;
    } = {},
  ) => recordingState({
    heartbeatAgeSec,
    settings,
    nowSec: extra.nowSec ?? NOW,
    totalSessionCount: extra.totalSessionCount,
    starting: extra.starting,
    launchGrace: extra.launchGrace,
  });

  it("reports a pause even while the tracker is stamping health", () => {
    // The health stamp is written before any recording gate is applied, so a
    // paused tracker is a live process recording nothing. Reading liveness as
    // "recording" is what told a paused reader Time was recording in the
    // background.
    expect(resolve({ ...recording, tracking_paused: "1" }, 1)).toEqual({
      kind: "paused",
      until: null,
    });
  });

  it("carries the resume time of a timed pause, and drops it once elapsed", () => {
    const settings = { ...recording, tracking_paused_until: String(NOW + 600) };
    expect(resolve(settings, 1)).toEqual({ kind: "paused", until: NOW + 600 });
    expect(resolve(settings, 1).kind).toBe("paused");
    expect(resolve(settings, 1, { nowSec: NOW + 601 }).kind).toBe("recording");
  });

  it("reports a live tracker outside scheduled hours as off_schedule", () => {
    const sundayMidnight = new Date(2026, 7, 9, 0, 0, 0).getTime() / 1000;
    const state = resolve({ ...recording, ...workWeek }, 1, { nowSec: sundayMidnight });
    expect(state.kind).toBe("off_schedule");
  });

  it("separates a true first run from a reader who switched recording off", () => {
    expect(resolve({ recording_consent: "0" }, null, { totalSessionCount: 0 }))
      .toEqual({ kind: "never_started" });
    expect(resolve({ recording_consent: "0" }, null, { totalSessionCount: 4_000 }))
      .toEqual({ kind: "consent_withdrawn" });
  });

  it("holds an unconfirmed start apart from a dead tracker", () => {
    expect(resolve(recording, null, { starting: true })).toEqual({ kind: "starting" });
    expect(resolve(recording, null).kind).toBe("stopped");
    // A start that has landed is recording, not still starting.
    expect(resolve(recording, 1, { starting: true }).kind).toBe("recording");
  });

  it("waits out the launch grace before calling a silent tracker stopped", () => {
    // The fresh-install flash this exists for: the dashboard is up and the
    // tracker is still unpacking itself, so the first read of a healthy launch
    // looks identical to a dead process.
    expect(resolve(recording, null, { launchGrace: true })).toEqual({ kind: "unconfirmed" });
    expect(resolve(recording, null, { launchGrace: false }).kind).toBe("stopped");
  });

  it("covers a stale stamp at launch too, not just a missing one", () => {
    // A clean shutdown zeroes the stamp, so a fresh launch usually reads null —
    // but a crash, a Task Manager kill, or a machine powered off mid-session
    // leaves the last stamp behind at whatever age it had reached. That number
    // describes the previous run and says nothing about the process that started
    // half a second ago, so it is the same ambiguity and gets the same grace.
    const stale = TRACKER_ALERT_STALE_SECONDS + 1;
    expect(resolve(recording, stale, { launchGrace: true }).kind).toBe("unconfirmed");
    expect(resolve(recording, stale, { launchGrace: false }).kind).toBe("stopped");
  });

  it("prefers the reader's own start over the launch grace", () => {
    // Both suppress the alarm, but `starting` names who is waiting and mounts a
    // panel that escalates on its own, so it has to win.
    expect(resolve(recording, null, { starting: true, launchGrace: true }).kind)
      .toBe("starting");
  });

  it("keeps a chosen silence ahead of the launch grace", () => {
    // Consent, pause, and schedule are resolved before liveness is consulted at
    // all, so the grace must not repaint any of them as an unknown.
    expect(resolve({ recording_consent: "0" }, null, { launchGrace: true }).kind)
      .toBe("never_started");
    expect(resolve({ ...recording, tracking_paused: "1" }, null, { launchGrace: true }).kind)
      .toBe("paused");
  });

  it("shows no banner at all during the launch grace", () => {
    // Not even the welcome copy: it asserts recording is under way, which is
    // exactly what has not been established yet.
    const plan = bannerFor({ kind: "unconfirmed" }, {
      readerIsNew: true,
      settings: recording,
      pauseNoticeDismissed: false,
    });
    expect(plan).toBeNull();
  });

  it("agrees with trackerNeedsAttention on every input", () => {
    const cases: [Record<string, string>, number | null][] = [
      [recording, null],
      [recording, TRACKER_ALERT_STALE_SECONDS + 1],
      [recording, 45],
      [{ recording_consent: "0" }, null],
      [{ ...recording, tracking_paused: "1" }, 10_000],
      [{ ...recording, ...workWeek }, 10_000],
    ];
    for (const [settings, age] of cases) {
      expect(resolve(settings, age).kind === "stopped").toBe(
        trackerNeedsAttention({ heartbeatAgeSec: age, settings, nowSec: NOW }),
      );
    }
  });
});

describe("readerIsNew", () => {
  it("treats an empty database as new", () => {
    expect(readerIsNew(null, NOW)).toBe(true);
  });

  it("expires on its own, so a long-time reader stops being greeted", () => {
    expect(readerIsNew(NOW - DAY, NOW)).toBe(true);
    expect(readerIsNew(NOW - (WELCOME_MAX_HISTORY_DAYS + 1) * DAY, NOW)).toBe(false);
  });
});

describe("bannerFor", () => {
  const context = (over: Partial<Parameters<typeof bannerFor>[1]> = {}) => ({
    readerIsNew: false,
    settings: {} as Record<string, string>,
    pauseNoticeDismissed: false,
    ...over,
  });

  it("greets a new reader and says nothing to an established one", () => {
    const state: RecordingState = { kind: "recording" };
    expect(bannerFor(state, context({ readerIsNew: true }))?.id).toBe("welcome");
    expect(bannerFor(state, context())).toBeNull();
  });

  it("keeps the welcome retired once it has been dismissed", () => {
    expect(bannerFor({ kind: "recording" }, context({
      readerIsNew: true,
      settings: { [WELCOME_DISMISSED_KEY]: "1" },
    }))).toBeNull();
  });

  it("leaves the true first run undismissable", () => {
    // After "Not now" on the privacy screen this panel is the only route to
    // start recording outside Settings.
    expect(bannerFor({ kind: "never_started" }, context())).toMatchObject({
      id: "start_recording",
      dismissible: false,
    });
  });

  it("lets a reader who switched recording off dismiss the notice", () => {
    const state: RecordingState = { kind: "consent_withdrawn" };
    expect(bannerFor(state, context())).toMatchObject({
      id: "recording_off",
      dismissible: true,
      scope: "insights",
    });
    expect(bannerFor(state, context({
      settings: { [RECORDING_OFF_DISMISSED_KEY]: "1" },
    }))).toBeNull();
  });

  it("never shows welcome copy to an established reader mid-start", () => {
    expect(bannerFor({ kind: "starting" }, context())).toBeNull();
    expect(bannerFor({ kind: "starting" }, context({ readerIsNew: true }))?.id)
      .toBe("start_recording");
  });

  it("carries the pause onto every tab and lets it be dismissed", () => {
    const state: RecordingState = { kind: "paused", until: null };
    expect(bannerFor(state, context())).toMatchObject({
      id: "paused",
      scope: "all",
      dismissible: true,
      // No settings key: dismissal lasts for this pause episode only.
      dismissKey: null,
    });
    expect(bannerFor(state, context({ pauseNoticeDismissed: true }))).toBeNull();
  });

  it("keeps the schedule notice to Insights and dismisses it for good", () => {
    const state: RecordingState = { kind: "off_schedule", nextStart: null, valid: true };
    expect(bannerFor(state, context())).toMatchObject({
      id: "off_schedule",
      scope: "insights",
      dismissKey: OFF_SCHEDULE_DISMISSED_KEY,
    });
    expect(bannerFor(state, context({
      settings: { [OFF_SCHEDULE_DISMISSED_KEY]: "1" },
    }))).toBeNull();
  });

  it("leaves the one alarm undismissable, on every tab", () => {
    // The only state the reader did not choose and cannot otherwise detect.
    expect(bannerFor({ kind: "stopped" }, context({
      settings: {
        [WELCOME_DISMISSED_KEY]: "1",
        [RECORDING_OFF_DISMISSED_KEY]: "1",
        [OFF_SCHEDULE_DISMISSED_KEY]: "1",
      },
      pauseNoticeDismissed: true,
    }))).toMatchObject({ id: "stopped", scope: "all", dismissible: false });
  });
});
