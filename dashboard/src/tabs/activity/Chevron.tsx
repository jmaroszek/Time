/** `bold` is for a chevron that heads a row beside a swatch and a semibold
 *  name; at the default weight it reads as a hairline next to them. */
export default function Chevron({ open, bold = false }: { open: boolean; bold?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={bold ? 2.75 : 2}
      strokeLinecap={bold ? "round" : undefined}
      strokeLinejoin={bold ? "round" : undefined}
      className={`${bold ? "h-3.5 w-3.5" : "h-3 w-3"} shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
