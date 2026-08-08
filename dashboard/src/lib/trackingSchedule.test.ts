import { describe, expect, it } from "vitest";

import {
  scheduleInputToMinute,
  scheduleMinuteToInput,
  trackingScheduleState,
} from "./trackingSchedule";

const base = {
  tracking_schedule_enabled: "1",
  tracking_schedule_days: "0,1,2,3,4",
  tracking_schedule_start_minute: "540",
  tracking_schedule_end_minute: "1020",
};

describe("trackingScheduleState", () => {
  it("allows the selected daytime window and excludes its end boundary", () => {
    expect(trackingScheduleState(base, new Date(2026, 7, 3, 9, 0)).recordingAllowed).toBe(true);
    expect(trackingScheduleState(base, new Date(2026, 7, 3, 16, 59)).recordingAllowed).toBe(true);
    const ended = trackingScheduleState(base, new Date(2026, 7, 3, 17, 0));
    expect(ended.recordingAllowed).toBe(false);
    expect(ended.nextStart).toEqual(new Date(2026, 7, 4, 9, 0));
  });

  it("treats an overnight window's early hours as part of the previous selected day", () => {
    const overnight = {
      ...base,
      tracking_schedule_days: "0",
      tracking_schedule_start_minute: "1320",
      tracking_schedule_end_minute: "360",
    };
    expect(trackingScheduleState(overnight, new Date(2026, 7, 3, 23, 0)).recordingAllowed).toBe(true);
    expect(trackingScheduleState(overnight, new Date(2026, 7, 4, 5, 59)).recordingAllowed).toBe(true);
    expect(trackingScheduleState(overnight, new Date(2026, 7, 4, 6, 0)).recordingAllowed).toBe(false);
  });

  it("fails closed for no selected days or equal boundaries", () => {
    expect(trackingScheduleState({ ...base, tracking_schedule_days: "" }).valid).toBe(false);
    const equal = trackingScheduleState({
      ...base,
      tracking_schedule_end_minute: base.tracking_schedule_start_minute,
    });
    expect(equal.valid).toBe(false);
    expect(equal.recordingAllowed).toBe(false);
  });

  it("leaves recording unrestricted when scheduling is disabled", () => {
    expect(trackingScheduleState({ ...base, tracking_schedule_enabled: "0" }).recordingAllowed).toBe(true);
  });
});

it("converts schedule minutes to and from time inputs", () => {
  expect(scheduleMinuteToInput("540", 0)).toBe("09:00");
  expect(scheduleMinuteToInput("bad", 1020)).toBe("17:00");
  expect(scheduleInputToMinute("22:30")).toBe(1350);
  expect(scheduleInputToMinute("25:00")).toBeNull();
});
