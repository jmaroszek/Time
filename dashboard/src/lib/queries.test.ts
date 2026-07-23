import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, getDb, invoke, invalidateHistory } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  getDb: vi.fn(),
  invoke: vi.fn(),
  invalidateHistory: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./db", () => ({ getDb }));
vi.mock("./historyInvalidation", () => ({ invalidateHistory }));

import {
  DEFAULT_USER_SETTINGS,
  deleteActivity,
  deleteHistoryBefore,
  eraseAllHistory,
  restoreDefaultSettings,
} from "./queries";

describe("destructive history commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(1);
    getDb.mockResolvedValue({ execute: dbExecute });
  });

  it("centrally invalidates history after targeted, retention, and full deletion", async () => {
    await deleteActivity({
      mode: "sessions",
      sessionIds: [4],
      snapshotMaxId: 10,
    });
    await deleteHistoryBefore(1_000);
    await eraseAllHistory();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "delete_activity",
      "delete_history_before",
      "erase_history",
    ]);
    expect(invalidateHistory).toHaveBeenCalledTimes(3);
  });

  it("invalidates cached history even when native cleanup reports an error", async () => {
    invoke.mockRejectedValueOnce(new Error("compact failed"));
    await expect(eraseAllHistory()).rejects.toThrow("compact failed");
    expect(invalidateHistory).toHaveBeenCalledOnce();
  });
});

describe("default settings restoration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDb.mockResolvedValue({ execute: dbExecute });
    dbExecute.mockResolvedValue({ rowsAffected: 0 });
  });

  it("upserts only the user-facing defaults in one atomic statement", async () => {
    await restoreDefaultSettings();

    expect(dbExecute).toHaveBeenCalledOnce();
    const [sql, values] = dbExecute.mock.calls[0];
    expect(sql).toContain("INSERT INTO settings");
    expect(sql).toContain("ON CONFLICT(key) DO UPDATE");
    expect(values).toEqual(Object.entries(DEFAULT_USER_SETTINGS).flat());
    expect(DEFAULT_USER_SETTINGS).not.toHaveProperty("privacy_onboarding_complete");
    expect(DEFAULT_USER_SETTINGS).not.toHaveProperty("process_aliases");
    expect(DEFAULT_USER_SETTINGS).not.toHaveProperty("tracker_health_heartbeat");
  });
});
