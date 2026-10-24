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
  assignEntityRule,
  backupDatabase,
  chooseDatabaseBackupFile,
  deleteActivity,
  deleteHistoryBefore,
  eraseAllHistory,
  fetchCategories,
  fetchSessions,
  fetchTrackerStatus,
  inspectDatabaseBackup,
  listDatabaseBackups,
  restoreDatabase,
  restoreDefaultSettings,
  setCategoryGoal,
  takeRestoreNotice,
  updateRule,
} from "./queries";

describe("session fetch transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue({
      ids: [1],
      starts: [100],
      ends: [200],
      processes: ["code.exe"],
      titles: [""],
      domains: [null],
      isAfk: [false],
      categoryOverrideIds: [null],
      isCorrected: [false],
    });
  });

  it("requests the exact overlap window without a legacy start bound", async () => {
    await expect(fetchSessions(100, 200)).resolves.toEqual([
      {
        id: 1,
        start: 100,
        end: 200,
        process: "code.exe",
        title: "",
        domain: null,
        isAfk: false,
        categoryOverrideId: null,
        isCorrected: false,
      },
    ]);
    expect(invoke).toHaveBeenCalledWith("fetch_sessions", { startSec: 100, endSec: 200 });
  });
});

describe("rule updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDb.mockResolvedValue({ execute: dbExecute });
    dbExecute.mockResolvedValue({ rowsAffected: 1 });
  });

  it("replaces an entity rule through one native transaction", async () => {
    await assignEntityRule("process", "  EDITOR.EXE  ", 4);
    expect(invoke).toHaveBeenCalledWith("assign_entity_rule", {
      matchType: "process", pattern: "editor.exe", categoryId: 4, priority: 3,
    });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("updates one rule by id with normalized fields and fixed precedence", async () => {
    await updateRule(17, "title", "  Standup  ", 4, {
      scopeKind: "domain",
      scopeValue: "Example.com",
      titleMatchMode: "segment",
      titleAnchor: "first",
    });

    expect(dbExecute).toHaveBeenCalledOnce();
    const [sql, values] = dbExecute.mock.calls[0];
    expect(sql).toContain("UPDATE rules SET");
    expect(sql).toContain("WHERE id=$9");
    expect(values).toEqual([
      "title",
      "standup",
      4,
      0,
      "domain",
      "example.com",
      "segment",
      "first",
      17,
    ]);
  });
});

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
      "run_tracking_lifecycle",
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
    invoke.mockResolvedValue({
      recordingConsent: false,
      launchAtLogin: false,
      scheduleEnabled: false,
      trackerStarted: false,
      deletedCount: 0,
    });
  });

  it("delegates the full defaults reset to the native lifecycle command", async () => {
    await restoreDefaultSettings();

    expect(invoke).toHaveBeenCalledWith("run_tracking_lifecycle", {
      action: { action: "restore_defaults" },
    });
    expect(DEFAULT_USER_SETTINGS.color_palette).toBe("slate");
    expect(DEFAULT_USER_SETTINGS.productivity_style).toBe("vivid");
    expect(DEFAULT_USER_SETTINGS.activity_noise_max_sessions).toBe("1");
    expect(DEFAULT_USER_SETTINGS.show_tray_icon).toBe("1");
    expect(DEFAULT_USER_SETTINGS.feedback_prompts_enabled).toBe("1");
    expect(DEFAULT_USER_SETTINGS.theme).toBe("system");
  });
});

describe("backup and restore commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(null);
  });

  it("keeps backup discovery, inspection, restore, and restart notice native", async () => {
    await backupDatabase("Before cleanup");
    await listDatabaseBackups();
    await inspectDatabaseBackup("C:\\Backups\\one.db");
    await chooseDatabaseBackupFile();
    await restoreDatabase("C:\\Backups\\one.db");
    await takeRestoreNotice();

    expect(invoke.mock.calls).toEqual([
      ["backup_database", { backupName: "Before cleanup" }],
      ["list_database_backups"],
      ["inspect_database_backup", { backupPath: "C:\\Backups\\one.db" }],
      ["choose_database_backup_file"],
      ["restore_database", { backupPath: "C:\\Backups\\one.db" }],
      ["take_restore_notice"],
    ]);
  });
});

/**
 * `show_tray_icon` says what was asked for; this says what the tracker managed.
 * The distinction only pays off if "no tracker has answered yet" stays distinct
 * from "there is no tray" — reading a missing key as `false` would accuse every
 * fresh install of a broken tray for the seconds before the tracker first
 * publishes, which is precisely the false alarm this is meant to avoid.
 */
describe("tracker tray reporting", () => {
  const withTrayValue = (tray: string | null) => {
    const select = vi.fn().mockResolvedValue([
      { last_hb: 1_000, live_n: 1, total_n: 2, tray },
    ]);
    getDb.mockResolvedValue({ select });
    return select;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a published tray state in both directions", async () => {
    withTrayValue("1");
    expect((await fetchTrackerStatus()).trayActive).toBe(true);
    withTrayValue("0");
    expect((await fetchTrackerStatus()).trayActive).toBe(false);
  });

  it("keeps an unpublished tray state unknown rather than absent", async () => {
    withTrayValue(null);
    expect((await fetchTrackerStatus()).trayActive).toBeNull();
  });

  it("still reports the rest of the status", async () => {
    withTrayValue("1");
    const status = await fetchTrackerStatus();
    expect(status.lastHeartbeat).toBe(1_000);
    expect(status.liveSessionCount).toBe(1);
    expect(status.totalSessionCount).toBe(2);
  });
});

describe("category goals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads a nonzero weekly goal into the category and leaves zero as none", async () => {
    const select = vi.fn().mockResolvedValue([
      { id: 1, name: "Study", color: "#111", is_productive: 1, is_neutral: 0, is_ignored: 0, sort_order: 1, weekly_goal_hours: 10, goal_kind: "at_least" },
      { id: 2, name: "Media", color: "#222", is_productive: 0, is_neutral: 0, is_ignored: 0, sort_order: 2, weekly_goal_hours: 5, goal_kind: "at_most" },
      { id: 3, name: "Chat", color: "#333", is_productive: 0, is_neutral: 1, is_ignored: 0, sort_order: 3, weekly_goal_hours: 0, goal_kind: "at_most" },
    ]);
    getDb.mockResolvedValue({ select });
    const categories = await fetchCategories();
    expect(categories.map((category) => category.goal)).toEqual([
      { hours: 10, kind: "at_least" },
      { hours: 5, kind: "at_most" },
      undefined,
    ]);
    expect("goal" in categories[2]).toBe(false);
  });

  it("writes a goal on its own, and clears it to zero", async () => {
    getDb.mockResolvedValue({ execute: dbExecute });
    await setCategoryGoal(4, { hours: 8, kind: "at_most" });
    await setCategoryGoal(4, null);
    expect(dbExecute.mock.calls).toEqual([
      ["UPDATE categories SET weekly_goal_hours = $1, goal_kind = $2 WHERE id = $3", [8, "at_most", 4]],
      ["UPDATE categories SET weekly_goal_hours = $1, goal_kind = $2 WHERE id = $3", [0, "at_least", 4]],
    ]);
  });
});
