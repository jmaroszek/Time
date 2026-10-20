export function CategoryDot({ color, label }: { color: string; label?: string }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${label ? "cursor-pointer" : ""}`}
      style={{ backgroundColor: color }}
      title={label}
    />
  );
}

/**
 * The productivity states a subject's time is in, as a dot: solid for one, cut
 * into equal wedges for several (a half-and-half dot for two), and an outline
 * ring when none of its time is categorized.
 */
export function StateDot({ colors }: { colors: string[] }) {
  const wedge = 100 / Math.max(colors.length, 1);
  const style = colors.length === 0
    ? { boxShadow: "inset 0 0 0 1.5px var(--color-ink-3)" }
    : colors.length === 1
      ? { backgroundColor: colors[0] }
      : {
          background: `conic-gradient(from 0deg, ${colors
            .map((color, i) => `${color} ${i * wedge}% ${(i + 1) * wedge}%`)
            .join(", ")})`,
        };
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={style}
    />
  );
}
