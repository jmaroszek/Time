import { useEffect, useRef, useState } from "react";

import { Button, ConfirmDialog, DialogShell } from "../../components/ui";
import { BackupNameDialog } from "../../components/BackupNameDialog";
import { buildActivityExport } from "../../lib/activityExport";
import { getDbPath } from "../../lib/db";
import { explainDbError } from "../../lib/dbErrors";
import {
  chooseDatabaseBackupFile,
  countSessionsOlderThan,
  deleteHistoryBefore,
  eraseAllHistory,
  fetchSessions,
  inspectDatabaseBackup,
  listDatabaseBackups,
  restoreDatabase,
  revealDatabase,
  saveActivityExport,
  type DatabaseBackup,
} from "../../lib/queries";
import { useBanner } from "../../state/banner";
import { useLifecycleBusy } from "../../state/lifecycleBusy";
import { useMeta } from "../../state/meta";
import { Section } from "./chrome";
import { InlineAction, Row, TextAction, handleRadioKey, sanitizeNumericDraft } from "./fields";

const MAX_RETENTION_DAYS = 36_500;

export default function DataSection({
  settingsBusy,
}: {
  settingsBusy: boolean;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const lifecycleBusy = useLifecycleBusy();
  const mutationsBusy = settingsBusy || lifecycleBusy;
  const [olderDays, setOlderDays] = useState("365");
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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

  useEffect(() => {
    if (!mutationsBusy) return;
    // BackupNameDialog predates the shared lifecycle gate and has no disabled
    // prop; close it if another native operation becomes busy so it cannot
    // submit a backup around that gate. Restore/delete/erase dialogs receive
    // an explicit disabled/confirmDisabled state and remain visible so a
    // failed operation is still actionable.
    setBackupNameOpen(false);
  }, [mutationsBusy]);

  const normalizeOlderDays = () => {
    const parsed = Math.floor(Number(olderDays));
    const clamped = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 365, 1), MAX_RETENTION_DAYS);
    setOlderDays(String(clamped));
  };

  const showInFolder = async () => {
    try {
      await revealDatabase();
    } catch (e) {
      banner.report(e, "opening the data folder");
    }
  };

  // Every recorded session, through the same builder as Activity's range
  // export. Window titles stay out: Activity offers them behind an explicit
  // checkbox, and an all-time file is the last place to include them silently.
  const exportAll = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      // Through the end of today, so the file is named for today rather than
      // for whatever day the cutoff lands in.
      const endOfToday = new Date();
      endOfToday.setHours(24, 0, 0, 0);
      const endSec = endOfToday.getTime() / 1000;
      const sessions = await fetchSessions(0, endSec);
      if (sessions.length === 0) {
        setMessage("There is no recorded activity to export yet.");
        return;
      }
      const startSec = Math.min(...sessions.map((session) => session.start));
      const file = buildActivityExport("sessions", {
        sessions,
        categories: meta.categories,
        rules: meta.rules,
        browserProcesses: [...meta.browserSet].sort(),
        aliases: meta.aliases,
      }, startSec, endSec);
      const path = await saveActivityExport(file.suggestedName, file.contents);
      if (path) banner.show(`Export saved to ${path}`);
    } catch (e) {
      banner.report(e, "export");
    } finally {
      setExporting(false);
    }
  };

  const closeRestore = () => {
    setRestoreOpen(false);
    requestAnimationFrame(() => restoreButtonRef.current?.focus());
  };

  // Counting before asking is the point of the dialog: a native confirm could
  // only ever say "older than 365 days", never how many sessions that is.
  const deleteOlder = async () => {
    if (mutationsBusy) return;
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
    if (!pendingOlder || mutationsBusy) return;
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
    if (mutationsBusy) return;
    setBusyAction("erase");
    try {
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
      {/* One action per row, and every action a word rather than a box. This
          card used to open on the database path in a monospace field — a
          developer's detail, and the most prominent thing in the section —
          under two large buttons and above a stepper beside a trash can. The
          path is still one hover away on "Show in folder". */}
      <Row
        label="Your data"
        help="Stored only on this computer. Nothing is uploaded."
        control={
          <TextAction title={getDbPath()} onClick={() => void showInFolder()}>
            Show in folder
          </TextAction>
        }
      />
      <Row
        label="Backups"
        help={
          <>
            Saved next to your data.{" "}
            <InlineAction
              buttonRef={restoreButtonRef}
              disabled={mutationsBusy}
              onClick={() => setRestoreOpen(true)}
            >
              Restore a backup…
            </InlineAction>
          </>
        }
        control={
          <TextAction disabled={mutationsBusy} onClick={() => setBackupNameOpen(true)}>
            Back up now
          </TextAction>
        }
      />
      <Row
        label="Export activity"
        help="All recorded history as a CSV file."
        control={
          <TextAction disabled={exporting} onClick={() => void exportAll()}>
            {exporting ? "Preparing…" : "Export CSV"}
          </TextAction>
        }
      />
      <Row
        label={
          <>
            Delete history older than
            <input
              type="text"
              inputMode="numeric"
              aria-label="Days of history to keep"
              value={olderDays}
              disabled={mutationsBusy || busyAction !== null}
              onChange={(event) => setOlderDays(sanitizeNumericDraft(event.target.value, false))}
              onBlur={normalizeOlderDays}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="mx-1 w-[2.8em] border-0 border-b border-dashed border-ink-3 bg-transparent pb-px text-center font-semibold tabular-nums text-ink outline-none focus:border-solid focus:border-accent disabled:opacity-50"
            />
            days
          </>
        }
        help="Categories and rules are kept."
        control={
          <TextAction
            danger
            disabled={mutationsBusy || busyAction !== null}
            onClick={() => void deleteOlder()}
          >
            Delete…
          </TextAction>
        }
      />
      <Row
        label="Erase all recorded history"
        help="Erases all history and turns recording off. Categories, rules, and backups are kept."
        control={
          <TextAction
            danger
            disabled={mutationsBusy || busyAction !== null}
            onClick={() => setEraseOpen(true)}
          >
            Erase all…
          </TextAction>
        }
      />
      {message && <p className="border-t border-surface-2 px-4 py-3 text-xs text-ink-2">{message}</p>}
      {restoreOpen && (
        <RestoreBackupDialog
          disabled={mutationsBusy}
          onClose={closeRestore}
        />
      )}
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
          confirmDisabled={mutationsBusy}
          extraAction={
            <Button
              disabled={mutationsBusy || busyAction !== null}
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
          confirmDisabled={mutationsBusy}
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

function RestoreBackupDialog({
  disabled,
  onClose,
}: {
  disabled?: boolean;
  onClose: () => void;
}) {
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
    if (disabled) return;
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
    if (disabled || !selected?.compatible) return;
    setRestoring(true);
    try {
      await restoreDatabase(selected.path);
      setRestoring(false);
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
                    disabled={disabled || restoring}
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
          disabled={disabled || restoring}
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
            disabled={disabled || !selected?.compatible || restoring}
            onClick={() => void restore()}
            className="rounded-[8px] border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {restoring ? "Restoring…" : "Restore and restart"}
          </button>
        </div>
    </DialogShell>
  );
}
