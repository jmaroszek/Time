import { formatSharePercent } from "../../lib/activityFormat";

/** A relative-length activity bar with an exact absolute share on hover. */
export default function ShareBar({
  seconds,
  maxSeconds,
  totalSeconds,
}: {
  seconds: number;
  maxSeconds: number;
  totalSeconds: number;
}) {
  if (maxSeconds <= 0) return null;
  return (
    <span
      aria-hidden="true"
      title={`${formatSharePercent(seconds, totalSeconds)} of recorded time in range`}
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${Math.max((seconds / maxSeconds) * 100, 1.5)}%` }}
      />
    </span>
  );
}
