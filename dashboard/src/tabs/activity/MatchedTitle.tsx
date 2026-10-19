import { titleMatchParts } from "../../lib/activityFormat";

/** Keeps the reason a title matched visible even when the title is clipped. */
export default function MatchedTitle({
  title,
  search,
  tooltip = title,
}: {
  title: string;
  search: string;
  /** For a caller showing a shortened title, so hovering still gives the
   *  whole one. A nested title attribute wins over any on the row itself. */
  tooltip?: string;
}) {
  if (!title) return <span className="text-ink-3">—</span>;
  const parts = titleMatchParts(title, search);
  if (!parts) return <span className="block truncate" title={tooltip}>{title}</span>;
  return (
    <span className="block truncate" title={tooltip}>
      {parts.elided && <span className="text-ink-3">…</span>}
      {parts.head}
      <mark className="rounded-[2px] bg-accent/20 px-[1px] text-ink">{parts.hit}</mark>
      {parts.tail}
    </span>
  );
}
