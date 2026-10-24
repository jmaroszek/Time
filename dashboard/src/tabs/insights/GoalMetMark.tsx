/**
 * Shown beside a figure's label only while the period's total is past its
 * goal. Deliberately this quiet: no fill, no chip, no label text. A goal met is
 * worth noticing when you happen to look at the tile, not worth an
 * announcement — and the figure beside it already says by how much.
 */
export function GoalMetMark() {
  return (
    <span
      title="Goal met for this period"
      className="flex items-center text-good-data opacity-80"
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
        <path d="M1.6 5.4 3.7 7.5 8.4 2.8" />
      </svg>
    </span>
  );
}
