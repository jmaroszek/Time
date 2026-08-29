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
  backupDatabase,
  chooseDatabaseBackupFile,
  deleteActivity,
  deleteHistoryBefore,
  eraseAllHistory,
  fetchSessions,
  fetchTrackerStatus,
  inspectDatabaseBackup,
  listDatabaseBackups,
  restoreDatabase,
  restoreDefaultSettings,
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
