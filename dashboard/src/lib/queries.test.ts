import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, invalidateHistory } = vi.hoisted(() => ({
  invoke: vi.fn(),
  invalidateHistory: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./historyInvalidation", () => ({ invalidateHistory }));

import { deleteActivity, deleteHistoryBefore, eraseAllHistory } from "./queries";

describe("destructive history commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(1);
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
