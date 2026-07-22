// Keyboard movement for the custom listbox in components/ui.tsx. It lives here,
// apart from the component, because the dashboard suite runs without a DOM and
// this is the part worth testing: replacing a native <select> gives up keyboard
// behavior that used to be free.

/** Arrow/Home/End movement. Clamps at both ends — the ARIA listbox pattern
 *  does not wrap, and a wrapping list makes "am I at the bottom?" unanswerable
 *  without looking. Returns null for keys that mean nothing here. */
export function moveIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  // A closed menu has no active option; arrowing into it starts at an end.
  const from = current < 0 ? -1 : Math.min(current, last);
  switch (key) {
    case "ArrowDown":
      return Math.min(from + 1, last);
    case "ArrowUp":
      return from < 0 ? last : Math.max(from - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * Prefix match for type-to-select, searching forward from the active option and
 * wrapping. Unlike arrow movement this wraps, because typing a letter means
 * "find me that entry" rather than "step one row".
 *
 * A repeated single character cycles between entries sharing that initial —
 * pressing "m" twice moves Month -> May rather than sticking on Month, which is
 * what both native selects and Windows list views do.
 */
export function typeaheadIndex(
  labels: string[],
  buffer: string,
  current: number,
): number | null {
  if (!buffer) return null;
  const query = buffer.toLowerCase();
  const repeatedChar = buffer.length > 1 && [...buffer].every((c) => c === buffer[0]);
  const needle = repeatedChar ? query[0] : query;
  // Cycling starts past the active row; a growing buffer re-tests it, so that
  // typing "ma" does not skip a Month the "m" already landed on.
  const offset = repeatedChar ? 1 : 0;
  for (let step = 0; step < labels.length; step++) {
    const i = (Math.max(current, 0) + offset + step) % labels.length;
    if (labels[i].toLowerCase().startsWith(needle)) return i;
  }
  return null;
}
