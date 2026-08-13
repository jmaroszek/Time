import { describe, expect, it } from "vitest";

import {
  TRACKER_ALERT_STALE_SECONDS,
  trackerNeedsAttention,
} from "./trackerHealth";

const NOW = 1_800_000_000;
const recording = { recording_consent: "1" };

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
        settings: {
          ...recording,
          tracking_schedule_enabled: "1",
          tracking_schedule_days: "1,2,3,4,5",
          tracking_schedule_start_minute: "540",
          tracking_schedule_end_minute: "1020",
        },
        nowSec: sundayMidnight,
      }),
    ).toBe(false);
  });
});
