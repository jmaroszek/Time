// Keyboard switching between the top-level tabs. It lives apart from App so the
// DOM-free suite can test it: the tab strip scrolls off the top of a long page,
// and these keys are the way back that does not involve scrolling to it.

export type ShortcutKey = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/**
 * The tab a key press asks for, or null when it is not a tab shortcut.
 *
 * Ctrl+1..N jumps straight to a tab and Ctrl+Tab / Ctrl+Shift+Tab step through
 * them — what browsers, VS Code and Windows Terminal do, so nothing here has to
 * be learned. Stepping wraps, unlike list movement, because a strip of three
 * has no "end" anyone is looking for.
 *
 * Digits are read from `code`, not `key`: on AZERTY the top-row 1 types "&"
 * unshifted, and a shortcut that only works on some layouts reads as broken.
 */
export function tabForShortcut<T>(event: ShortcutKey, tabs: readonly T[], current: T): T | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || tabs.length === 0) return null;
  if (event.key === "Tab") {
    const at = Math.max(0, tabs.indexOf(current));
    const step = event.shiftKey ? -1 : 1;
    return tabs[(at + step + tabs.length) % tabs.length];
  }
  if (event.shiftKey) return null;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  if (!digit) return null;
  return tabs[Number(digit[1]) - 1] ?? null;
}

/** The label a tab's tooltip and `aria-keyshortcuts` carry for its jump key. */
export function tabShortcutLabel(index: number): string {
  return `Ctrl+${index + 1}`;
}
