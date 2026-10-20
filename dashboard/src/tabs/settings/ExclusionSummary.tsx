import { useEffect, useState } from "react";

import { listTrackingExclusions } from "../../lib/queries";
import { TextAction } from "./fields";

/** Privacy stays discoverable from Settings without Settings hosting the list:
 *  exclusions are per-entity curation, and that belongs with the other
 *  per-entity work in Activity. This row only ever says how many there are —
 *  a count is the one rendering that reads the same at three exclusions and at
 *  three hundred — and hands off to the list that can actually edit them. */
export default function ExclusionSummary({ onManage }: { onManage: () => void }) {
  const [counts, setCounts] = useState<{ app: number; website: number } | null>(null);
  useEffect(() => {
    void listTrackingExclusions()
      .then((items) => setCounts({
        app: items.filter((item) => item.kind === "app").length,
        website: items.filter((item) => item.kind === "website").length,
      }))
      .catch(() => setCounts(null));
  }, []);
  if (counts === null) return null;
  const total = counts.app + counts.website;
  const parts = [
    `${counts.app} app${counts.app === 1 ? "" : "s"}`,
    `${counts.website} website${counts.website === 1 ? "" : "s"}`,
  ];
  return (
    <div className="flex flex-col items-start gap-2 border-t border-surface-2 px-4 py-[13px] sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="min-w-0 text-xs leading-snug text-ink-3">
        {total === 0
          ? "Nothing is excluded from tracking — mark an app or website “Do not track” in Activity."
          : `${parts.join(" and ")} are never tracked.`}
      </p>
      {total > 0 && (
        <TextAction onClick={onManage}>View and manage</TextAction>
      )}
    </div>
  );
}
