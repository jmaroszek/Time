import { useEffect, useRef, useState } from "react";

import { Button, Checkbox } from "../../components/ui";
import type { ActivitySource } from "../../lib/activity";
import { buildActivityExport, type ActivityExportKind } from "../../lib/activityExport";
import { saveActivityExport } from "../../lib/queries";
import type { Range } from "../../lib/time";
import { useBanner } from "../../state/banner";

export default function ActivityExportMenu({
  source,
  range,
  hasStoredTitles,
}: {
  source: ActivitySource;
  range: Range;
  hasStoredTitles: boolean;
}) {
  const banner = useBanner();
  const [includeTitles, setIncludeTitles] = useState(false);
  const [exporting, setExporting] = useState<ActivityExportKind | null>(null);
  const run = async (kind: ActivityExportKind) => {
    setExporting(kind);
    try {
      const file = buildActivityExport(
        kind,
        source,
        range.start.getTime() / 1000,
        range.end.getTime() / 1000,
        kind === "sessions" && includeTitles,
      );
      const path = await saveActivityExport(file.suggestedName, file.contents);
      if (path) banner.show(`Export saved to ${path}`);
    } catch (error) {
      banner.report(error, "export");
    } finally {
      setExporting(null);
    }
  };
  // A <details> keeps the disclosure free, but not the dismissal every other
  // menu in the app gives: without these it stays open until clicked again.
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: Event) => {
      const node = panel.current;
      if (node?.open && !node.contains(event.target as Node)) node.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && panel.current?.open) panel.current.open = false;
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <details ref={panel} className="relative">
      {/* An icon, because the word sat in the card's header competing with the
          view switcher for a control almost nobody presses. The tooltip keeps
          the noun — "export" alone never said what came out. */}
      {/* No border and the dimmest ink, matching the filtered-rows button it
          sits beside. A bordered box drew a rectangle in the corner of the
          card that outweighed everything in the header except the switcher —
          loud framing for the control here that is pressed least. It takes its
          definition on hover, like every other quiet control in the app. */}
      <summary
        title="Download CSV"
        aria-label="Download CSV"
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink-2"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      </summary>
      <div className="absolute right-0 top-9 z-30 w-64 rounded-xl border border-edge bg-surface p-3 shadow-xl">
        <p className="text-xs leading-snug text-ink-3">Uses the selected date range. Search and library filters do not remove rows.</p>
        <div className="mt-3 flex flex-col gap-2">
          <Button disabled={exporting !== null} onClick={() => void run("summary")}>{exporting === "summary" ? "Preparing…" : "Activity summary CSV"}</Button>
          <Button disabled={exporting !== null} onClick={() => void run("sessions")}>{exporting === "sessions" ? "Preparing…" : "Session details CSV"}</Button>
        </div>
        {hasStoredTitles && (
          <Checkbox
            checked={includeTitles}
            onChange={setIncludeTitles}
            align="start"
            className="mt-3 text-xs leading-snug text-ink-3"
          >
            Include stored window titles. They may contain private data.
          </Checkbox>
        )}
      </div>
    </details>
  );
}
