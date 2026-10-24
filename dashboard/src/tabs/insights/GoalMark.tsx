/**
 * Shown after a figure's target ("18h of 15h ✓") once the period has settled
 * its goal: a check for a target reached, a cross for a limit passed. Nothing
 * for a target not yet reached, since the period may still reach it.
 * Deliberately this quiet: no fill, no chip, no label text. A goal's outcome is
 * worth noticing when you happen to look at the tile, not worth an
 * announcement, and the figure beside it already says by how much. It sits in
 * the target's small text, centred on it, not on the large figure's line: the
 * label row already carries the hint and, on Goal pace, the chevron.
 */
export function GoalMark({ missed = false }: { missed?: boolean }) {
  return (
    <span
      title={missed ? "Over the limit for this period" : "Goal met for this period"}
      className={`flex shrink-0 opacity-80 ${missed ? "text-bad" : "text-good-data"}`}
    >
      <svg
        viewBox="0 0 10 10"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={missed ? "M2.6 2.6 7.4 7.4M7.4 2.6 2.6 7.4" : "M1.6 5.4 3.7 7.5 8.4 2.8"} />
      </svg>
    </span>
  );
}
