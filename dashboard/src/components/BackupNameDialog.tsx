import { useState } from "react";

import { explainDbError } from "../lib/dbErrors";
import { backupDatabase } from "../lib/queries";
import { Button, DialogShell } from "./ui";

/** A named file is easier to recognize at restore time than a timestamp alone. */
export function BackupNameDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (target: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  const save = async () => {
    if (!trimmedName || saving) return;
    setSaving(true);
    setError(null);
    try {
      const target = await backupDatabase(trimmedName);
      onClose();
      onSaved(target);
    } catch (cause) {
      setError(explainDbError(cause, "backup"));
      setSaving(false);
    }
  };

  return (
    <DialogShell
      onClose={onClose}
      busy={saving}
      labelledBy="save-backup-title"
      describedBy="save-backup-description"
      className="max-w-md"
    >
      <h2 id="save-backup-title" className="text-sm font-semibold text-ink">Save backup</h2>
      <p id="save-backup-description" className="mt-1 text-xs leading-relaxed text-ink-3">
        Give this snapshot a name so it is easy to find later. It will be saved only on this device.
      </p>
      <label className="mt-4 block">
        <span className="text-xs font-medium text-ink-2">Backup name</span>
        <input
          autoFocus
          value={name}
          disabled={saving}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
          aria-describedby={error ? "save-backup-error" : undefined}
          className="mt-1.5 w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-xs text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent/60"
          placeholder="For example, before deleting history"
        />
      </label>
      {error && <p id="save-backup-error" role="alert" className="mt-2 text-xs text-bad">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!trimmedName || saving}>
          {saving ? "Saving…" : "Save backup"}
        </Button>
      </div>
    </DialogShell>
  );
}
