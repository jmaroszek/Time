import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Button, ConfirmDialog, DialogShell, TrashButton } from "../../components/ui";
import { BackupNameDialog } from "../../components/BackupNameDialog";
import { getDbPath } from "../../lib/db";
import { explainDbError } from "../../lib/dbErrors";
import {
  chooseDatabaseBackupFile,
  countSessionsOlderThan,
  deleteHistoryBefore,
  eraseAllHistory,
  inspectDatabaseBackup,
  listDatabaseBackups,
  restoreDatabase,
  updateSetting,
  type DatabaseBackup,
} from "../../lib/queries";
import { useBanner } from "../../state/banner";
import { useMeta } from "../../state/meta";
import { Section } from "./chrome";
import { NumberStepper, Row, handleRadioKey, sanitizeNumericDraft } from "./fields";

const MAX_RETENTION_DAYS = 36_500;

export default function DataSection({ settingsBusy }: { settingsBusy: boolean }) {
  const meta = useMeta();
  const banner = useBanner();
  const [olderDays, setOlderDays] = useState("365");
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [backupNameOpen, setBackupNameOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // The retention delete carries its own counted scope, so it is held as a
  // pending request rather than a bare open flag.
  const [pendingOlder, setPendingOlder] = useState<
    { days: number; cutoff: number; count: number; what: string } | null
  >(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<"older" | "erase" | null>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);

  const normalizeOlderDays = () => {
    const parsed = Math.floor(Number(olderDays));
    const clamped = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 365, 1), MAX_RETENTION_DAYS);
    setOlderDays(String(clamped));
  };
  const stepOlderDays = (direction: -1 | 1) => {
    const parsed = Math.floor(Number(olderDays));
    const current = Number.isFinite(parsed) ? parsed : 365;
    setOlderDays(String(Math.min(Math.max(current + direction, 1), MAX_RETENTION_DAYS)));
  };

  const copyPath = () => void navigator.clipboard.writeText(getDbPath()).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });

  const closeRestore = () => {
    setRestoreOpen(false);
    requestAnimationFrame(() => restoreButtonRef.current?.focus());
  };

  // Counting before asking is the point of the dialog: a native confirm could
  // only ever say "older than 365 days", never how many sessions that is.
  const deleteOlder = async () => {
    const days = Math.floor(Number(olderDays));
    if (!Number.isFinite(days) || days < 1 || days > MAX_RETENTION_DAYS) {
      setOlderDays("365");
      return;
    }
    try {
      const cutoff = Date.now() / 1000 - days * 86_400;
      const count = await countSessionsOlderThan(cutoff);
      const what = `older than ${days} day${days === 1 ? "" : "s"}`;
      if (count === 0) {
        setMessage(`No recorded sessions ${what}.`);
        return;
      }
      setPendingOlder({ days, cutoff, count, what });
    } catch (e) {
      banner.report(e, "deletion");
    }
  };

  const runDeleteOlder = async () => {
    if (!pendingOlder) return;
    setBusyAction("older");
    try {
      await deleteHistoryBefore(pendingOlder.cutoff);
      setMessage(
        `Deleted ${pendingOlder.count} session${pendingOlder.count === 1 ? "" : "s"} ${pendingOlder.what}.`,
      );
      setPendingOlder(null);
      await meta.refresh();
    } catch (e) {
      banner.report(e, "deletion");
    } finally {
      setBusyAction(null);
    }
  };

  const eraseEverything = async () => {
    setBusyAction("erase");
    try {
      await updateSetting("recording_consent", "0");
      await updateSetting("launch_at_login", "0");
      await invoke("set_launch_at_login", { enabled: false });
      await invoke("stop_tracker");
      const n = await eraseAllHistory();
      setMessage(`Securely erased ${n} recorded session${n === 1 ? "" : "s"}. Separate backups were not deleted.`);
      setEraseOpen(false);
      await meta.refresh();
    } catch (e) {
      banner.report(e, "secure erase");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Section title="Data management">
      <div className="overflow-hidden rounded-[13px] border border-edge bg-surface-dim">
        <div className="p-4">
          <p className="mb-[9px] text-xs text-ink-3">Database path</p>
          <div className="flex items-center gap-2 rounded-[10px] border border-edge bg-surface-2 p-[9px] pl-[13px]">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={getDbPath()}>{getDbPath()}</span>
            <button
              type="button"
              className="rounded-[7px] border border-edge px-2.5 py-[5px] text-xs text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
              onClick={copyPath}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setBackupNameOpen(true)}
              className="flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-accent/30 bg-gradient-to-b from-accent/15 to-accent/[.08] py-[11px] text-xs font-semibold text-accent shadow-[inset_0_1px_0_rgba(255,255,255,.05)] transition-colors hover:from-accent/25 hover:to-accent/15"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v11" /><path d="M7 9l5 5 5-5" /><path d="M4 20h16" />
              </svg>
              Back up now
            </button>
            <button
              ref={restoreButtonRef}
              type="button"
              disabled={settingsBusy}
              title={settingsBusy ? "Wait for settings to finish saving" : undefined}
              onClick={() => setRestoreOpen(true)}
              className="flex flex-1 items-center justify-center gap-2 rounded-[10px] border border-edge bg-surface-2 py-[11px] text-xs font-semibold text-ink-2 transition-colors hover:border-edge-2 hover:bg-surface-3 hover:text-ink disabled:cursor-wait disabled:opacity-50"
            >
              Restore backup…
            </button>
          </div>
          <p className="mt-3 text-xs leading-snug text-ink-3">
            Backups are stored in a Backups folder beside this database. Everything stays on your machine.
          </p>
        </div>
        <Row
          label="Delete history older than"
          help="Removes everything recorded before the cutoff. Categories and rules are kept."
          control={
            <span className="flex flex-wrap items-center gap-2">
              <NumberStepper
                label="Days of history to keep"
                value={olderDays}
                unit="days"
                min={1}
                max={MAX_RETENTION_DAYS}
                step={1}
                onChange={(value) => setOlderDays(sanitizeNumericDraft(value, false))}
                onBlur={normalizeOlderDays}
                onMinus={() => stepOlderDays(-1)}
                onPlus={() => stepOlderDays(1)}
              />
              <TrashButton label="Delete older history" onClick={() => void deleteOlder()} />
            </span>
          }
        />
        <div className="flex flex-col items-start gap-2 border-t border-surface-2 bg-bad/[.03] px-4 py-[13px] sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="text-xs text-ink-3">Securely erase all recorded history</p>
          <button
            type="button"
            className="shrink-0 text-xs font-semibold text-bad transition-colors hover:text-bad/80"
            onClick={() => setEraseOpen(true)}
          >
            Erase all
          </button>
        </div>
        {message && <p className="border-t border-surface-2 px-4 py-3 text-xs text-ink-2">{message}</p>}
      </div>
      {restoreOpen && <RestoreBackupDialog onClose={closeRestore} />}
      {backupNameOpen && (
        <BackupNameDialog
          onClose={() => setBackupNameOpen(false)}
          onSaved={(target) => banner.show(`Backup saved to ${target}`)}
        />
      )}
      {pendingOlder && (
        <ConfirmDialog
          title="Delete recorded activity?"
          body={`Every session ${pendingOlder.what} will be removed.`}
          metrics={[{ label: "Sessions", value: String(pendingOlder.count) }]}
          note="Complete session rows are removed and securely compacted, and cannot be restored unless you have a backup. Categories and rules are kept."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          busy={busyAction === "older"}
          extraAction={
            <Button
              onClick={() => setBackupNameOpen(true)}
            >
              Back up first
            </Button>
          }
          onConfirm={() => void runDeleteOlder()}
          onClose={() => setPendingOlder(null)}
        />
      )}
      {eraseOpen && (
        <ConfirmDialog
          title="Erase all recorded history?"
          body="Every recorded session is removed and the database is compacted. Recording and Windows startup are turned off, and the tracker is stopped."
          note="Categories, rules, and settings are kept, and separate backup files are not deleted. Nothing here can be recovered without one of those backups."
          confirmLabel="Erase everything"
          busyLabel="Erasing…"
          busy={busyAction === "erase"}
          // The typed gate the window.prompt used to impose, kept — this is the
          // highest-stakes action in the product — but now with the consequences
          // above the field instead of inside the sentence asking for the word.
          requireTyped="DELETE"
          onConfirm={() => void eraseEverything()}
          onClose={() => setEraseOpen(false)}
        />
      )}
    </Section>
  );
}

function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function backupPrimaryLabel(backup: DatabaseBackup): string {
  const kind = backup.kind === "Manual"
    ? "Manual backup"
    : backup.kind === "Before update"
      ? "Pre-update backup"
      : backup.kind === "Before restore"
        ? "Pre-restore backup"
        : "Backup";
  return `${kind} · ${new Date(backup.modifiedSec * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const banner = useBanner();
  const [backups, setBackups] = useState<DatabaseBackup[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const selected = backups.find((backup) => backup.path === selectedPath) ?? null;

  useEffect(() => {
    void listDatabaseBackups()
      .then(setBackups)
      .catch((error: unknown) => setLoadError(explainDbError(error, "backups")))
      .finally(() => setLoading(false));
  }, []);
  const chooseAnother = async () => {
    try {
      const path = await chooseDatabaseBackupFile();
      if (!path) return;
      const inspected = await inspectDatabaseBackup(path);
      setBackups((current) => [
        inspected,
        ...current.filter((backup) => backup.path !== inspected.path),
      ]);
      setSelectedPath(inspected.path);
    } catch (error) {
      banner.report(error, "backup file");
    }
  };
  const restore = async () => {
    if (!selected?.compatible) return;
    setRestoring(true);
    try {
      await restoreDatabase(selected.path);
    } catch (error) {
      banner.report(error, "database restore");
      setRestoring(false);
    }
  };
  const paths = backups.map((backup) => backup.path);

  return (
    <DialogShell
      onClose={onClose}
      busy={restoring}
      labelledBy="restore-backup-title"
      describedBy="restore-backup-description"
      className="settings-dialog max-w-lg"
    >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 id="restore-backup-title" className="text-sm font-semibold text-ink">
              Restore backup
            </h2>
            <p id="restore-backup-description" className="mt-1 text-xs leading-relaxed text-ink-3">
              Choose a snapshot to replace history, categories, rules, and settings. Time creates a safety backup first, then restarts automatically.
            </p>
          </div>
          <button
            type="button"
            disabled={restoring}
            aria-label="Close restore backup dialog"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-ink-3 hover:bg-hover-2 hover:text-ink disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 max-h-[300px] overflow-y-auto rounded-[11px] border border-edge bg-surface-dim p-2">
          {loading && <p className="px-2 py-6 text-center text-xs text-ink-3">Finding backups…</p>}
          {loadError && <p className="px-2 py-4 text-xs text-bad">{loadError}</p>}
          {!loading && !loadError && backups.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-ink-3">
              No Time backups found yet.
            </p>
          )}
          {!loading && backups.length > 0 && (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Available backups">
              {backups.map((backup, index) => {
                const checked = selectedPath === backup.path;
                return (
                  <button
                    key={backup.path}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked || (selectedPath === null && index === 0) ? 0 : -1}
                    onClick={() => setSelectedPath(backup.path)}
                    onKeyDown={(event) => handleRadioKey(event, paths, index, setSelectedPath)}
                    className={`rounded-[9px] border px-3 py-2.5 text-left transition-colors ${
                      checked
                        ? "border-accent/60 bg-accent/[.08]"
                        : "border-transparent hover:border-edge hover:bg-surface-2"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                        {backupPrimaryLabel(backup)}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-ink-3" title={backup.path}>
                      {backup.name} · {formatBackupSize(backup.bytes)}
                      {backup.schemaVersion !== null && ` · Schema ${backup.schemaVersion}`}
                      {backup.legacyLocation && " · Legacy location"}
                    </span>
                    {backup.issue && (
                      <span className="mt-1 block text-xs leading-snug text-bad">
                        {backup.issue}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          disabled={restoring}
          onClick={() => void chooseAnother()}
          className="mt-3 text-xs font-semibold text-accent hover:text-accent/80 disabled:opacity-40"
        >
          Choose another file…
        </button>

        <div className="mt-4 rounded-[10px] border border-bad/25 bg-bad/[.035] px-3 py-2.5 text-xs leading-relaxed text-ink-3">
          Activity recorded after the selected backup will no longer appear. The automatic safety backup lets you restore the current state again if needed.
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={restoring}
            onClick={onClose}
            className="rounded-[8px] border border-edge px-3 py-1.5 text-xs font-semibold text-ink-2 hover:border-edge-2 hover:text-ink disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected?.compatible || restoring}
            onClick={() => void restore()}
            className="rounded-[8px] border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {restoring ? "Restoring…" : "Restore and restart"}
          </button>
        </div>
    </DialogShell>
  );
}
