import { type AvailableUpdate, downloadPercent, updateButtonLabel, type UpdateProgress } from "../lib/appUpdate";

/**
 * The whole update affordance: present only when there is something to install,
 * and absent entirely the rest of the time. It sits beside the tab strip rather
 * than inside Settings because an update nobody finds is an update nobody
 * applies — and beside it rather than in it, because the sliding pill measures
 * itself off the tab buttons and a fourth child in that container would join
 * the row it is measuring.
 *
 * At rest it is the download glyph the CSV export uses, at the same weight. The
 * label appears on hover and on keyboard focus, over the header rather than
 * within it: the wrapper holds a fixed 28px square and the button is absolute
 * inside it, so nothing reflows when the label arrives. That is not fussiness —
 * every tab here is one width for the same reason, because the date picker at
 * the other end of this header moves when anything to its left changes size.
 */
export function UpdateButton({
  update,
  installing,
  progress,
  onInstall,
}: {
  update: AvailableUpdate;
  installing: boolean;
  progress: UpdateProgress | null;
  onInstall: () => void;
}) {
  const label = updateButtonLabel(update, installing, progress);
  const percent = downloadPercent(progress);
  return (
    <div className="relative h-7 w-7 shrink-0">
      <button
        type="button"
        onClick={onInstall}
        disabled={installing}
        aria-label={label}
        className={`group absolute top-0 left-0 flex h-7 min-w-7 items-center justify-center rounded-lg px-1.5 whitespace-nowrap transition-colors motion-reduce:transition-none disabled:cursor-progress ${
          installing
            ? "bg-hover-2 text-ink-2"
            : "text-accent hover:bg-hover-2 focus-visible:bg-hover-2"
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
        {/* max-width rather than display, so the reveal can be animated and so
            the text stays in the accessible tree either way. */}
        <span
          aria-hidden="true"
          className={`overflow-hidden text-xs font-medium transition-all duration-150 motion-reduce:transition-none ${
            installing
              ? "ml-1.5 max-w-56 opacity-100"
              : "ml-0 max-w-0 opacity-0 group-hover:ml-1.5 group-hover:max-w-56 group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-56 group-focus-visible:opacity-100"
          }`}
        >
          {label}
        </span>
        {/* Measured against the button, not the 28px wrapper — the button is
            what grew. Absent until the endpoint declares a length, which is
            what tells the reader "working" from "half done". */}
        {installing && percent !== null && (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        )}
      </button>
    </div>
  );
}
