import { useEffect, useState } from "react";

import { Button, Checkbox, ConfirmDialog, RemoveButton, Spinner } from "../../components/ui";
import { formatShortDate } from "../../lib/activityFormat";
import { fmtDuration } from "../../lib/format";
import {
  addTrackingExclusion,
  listTrackingExclusions,
  previewTrackingExclusion,
  removeTrackingExclusion,
  type TrackingExclusion,
  type TrackingExclusionKind,
  type TrackingExclusionPreview,
} from "../../lib/queries";
import { useBanner } from "../../state/banner";
import RuleKindGlyph from "./RuleKindGlyph";
import SegmentedPills from "./SegmentedPills";

export default function ExcludedPanel() {
  const banner = useBanner();
  const [items, setItems] = useState<TrackingExclusion[] | null>(null);
  const [kind, setKind] = useState<TrackingExclusionKind>("app");
  const [draft, setDraft] = useState("");
  const [deleteHistory, setDeleteHistory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingHistoryDelete, setPendingHistoryDelete] =
    useState<TrackingExclusionPreview | null>(null);

  const load = () => listTrackingExclusions()
    .then(setItems)
    .catch((error: unknown) => banner.report(error, "tracking exclusions"));
  useEffect(() => { void load(); }, []);

  // Excluding is not destructive; excluding *and deleting the matching history*
  // is, so only that combination stops for a confirmation. The preview runs
  // first either way, because the count is what the confirmation is for.
  const add = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      const preview = await previewTrackingExclusion(kind, draft);
      if (deleteHistory && preview.count > 0) {
        setPendingHistoryDelete(preview);
        // Previewing is complete; the confirmation is a separate action. If
        // saving stays true, the dialog's destructive button is disabled and
        // the user can never commit the exclusion.
        setSaving(false);
        return;
      }
      await commit();
    } catch (error) {
      banner.report(error, "tracking exclusion");
      setSaving(false);
    }
  };

  const commit = async () => {
    try {
      const result = await addTrackingExclusion(kind, draft, deleteHistory);
      banner.show(deleteHistory
        ? `Excluded ${result.normalizedPattern} and deleted ${result.deletedCount} recorded visit${result.deletedCount === 1 ? "" : "s"}.`
        : `Excluded ${result.normalizedPattern} from future tracking.`);
      setDraft("");
      setDeleteHistory(false);
      setPendingHistoryDelete(null);
      await load();
    } catch (error) {
      banner.report(error, "tracking exclusion");
    } finally {
      setSaving(false);
    }
  };

  const lift = async (item: TrackingExclusion) => {
    try {
      await removeTrackingExclusion(item.kind, item.pattern);
      banner.show(`${item.pattern} can be tracked again. Deleted history was not restored.`);
      await load();
    } catch (error) {
      banner.report(error, "tracking exclusion");
    }
  };

  if (items === null) return <Spinner />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="shrink-0 text-xs leading-snug text-ink-3">
        Exact exclusions stop matching apps or detected websites from ever being stored, whenever
        recording is enabled. Lifting one resumes tracking from now on; history deleted with the
        exclusion is not restored.
      </p>
      <div className="scroll-well flex min-h-[160px] flex-1 flex-col gap-1.5 overflow-auto pr-4">
        {items.map((item) => (
          <div key={`${item.kind}:${item.pattern}`} className="flex items-center gap-2.5 rounded-lg border border-edge/60 bg-surface-2 px-3 py-2">
            <RuleKindGlyph matchType={item.kind === "app" ? "process" : "domain"} />
            {/* Sentence case: the glyph to the left already says "this is a kind",
                so small caps were restating it in the least legible way
                available. The panel eyebrow is the one uppercase marker left. */}
            <span className="w-[70px] shrink-0 text-xs text-ink-3">{item.kind === "app" ? "App" : "Website"}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={item.pattern}>{item.pattern}</span>
            <span className="shrink-0 text-xs text-ink-3">since {formatShortDate(item.createdTs)}</span>
            <RemoveButton label={`Allow ${item.pattern} to be tracked again`} onClick={() => void lift(item)} />
          </div>
        ))}
        {items.length === 0 && (
          <p className="py-6 text-center text-xs text-ink-3">
            Nothing is excluded. Open an app or website and choose “Do not track” to add one.
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-edge/50 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedPills
            label="Exclusion type"
            value={kind}
            options={[
              { value: "app", label: "App" },
              { value: "website", label: "Website" },
            ]}
            onChange={setKind}
            className="bg-surface-2"
            buttonClassName="px-2.5"
          />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void add(); }}
            placeholder={kind === "app" ? "code.exe" : "example.com"}
            aria-label={kind === "app" ? "App to exclude" : "Website to exclude"}
            className="min-w-0 flex-1 rounded-lg border border-control-edge bg-control px-2.5 py-1.5 font-mono text-xs outline-none placeholder:text-ink-3 focus:border-accent/60"
          />
          <Button variant="primary" disabled={saving || !draft.trim()} onClick={() => void add()}>Do not track</Button>
        </div>
        <Checkbox checked={deleteHistory} onChange={setDeleteHistory} className="mt-2 text-xs text-ink-3">
          Also delete matching history, after a count preview
        </Checkbox>
        {kind === "website" && (
          <p className="mt-1 text-xs text-ink-3">
            Website exclusions need a detected browser domain; otherwise exclude the whole browser as an App.
          </p>
        )}
      </div>
      {pendingHistoryDelete && (
        <ConfirmDialog
          title="Delete recorded activity?"
          body={
            <>
              Excluding{" "}
              <span className="font-mono font-semibold text-ink">
                {pendingHistoryDelete.normalizedPattern}
              </span>{" "}
              will also remove everything already recorded for it.
            </>
          }
          metrics={[
            // The tile counts the thing, so it takes the app's word for it.
            // The note below stays in the storage register on purpose: it is
            // describing what leaves the database, not what you were looking at.
            { label: "Visits", value: String(pendingHistoryDelete.count) },
            { label: "Recorded time", value: fmtDuration(pendingHistoryDelete.seconds) },
          ]}
          note="Complete session rows are removed and cannot be restored unless you have a backup. The exclusion itself can be lifted later, but deleted history does not come back with it."
          confirmLabel="Exclude and delete"
          busyLabel="Deleting…"
          busy={saving}
          onConfirm={() => void commit()}
          onClose={() => {
            setPendingHistoryDelete(null);
            setSaving(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Two different dead ends, and they were sharing one sentence: an empty range
 * and a search that matched nothing are not the same problem, even though
 * widening the range is worth offering for both.
 */
