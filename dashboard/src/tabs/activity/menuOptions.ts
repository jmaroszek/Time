import type { MenuOption } from "../../components/ui";
import type { Category } from "../../lib/classify";

/**
 * Where a triage row can go, with Time's guess — when there is one — marked
 * where it already sits.
 *
 * The guess lives in the menu rather than beside it because this list is the
 * one surface with room for it. A chip on the row had to share the row's tail
 * with the trigger, and since only some rows carry a guess, every layout that
 * fits both leaves the rows that have neither ragged or holed. A popup has as
 * many lines as it likes and every trigger stays the same box.
 *
 * The order never changes. Pinning the guess to the top read better in a
 * screenshot and worse in use: classifying a run of rows is muscle memory, and
 * a list that reorders itself per row means the position you just learned is
 * wrong on the next one. Marking in place costs a word and keeps the list
 * learnable.
 *
 * Marking is not selecting. The row's value stays empty, so no entry takes a
 * check and the trigger still reads "Classify" — the guess is labelled, not
 * taken. Declining it needs no separate control, because everywhere else the
 * row could go is in the same list at the position it always occupies.
 *
 * A suggested id naming no current category marks nothing. That is the same
 * direction starterSuggestions.ts fails in when a starter category is renamed
 * or deleted: the user's taxonomy wins, and a suggestion aimed at a category
 * they no longer keep disappears rather than following it somewhere else.
 */
/**
 * Every category a row can be sent to, ignored ones last behind a rule.
 *
 * Shared by every menu that assigns a category, because the ordering is a fact
 * about Ignored rather than about any one menu. The row-detail menus each built
 * their own list from `categories` in stored order, which put Ignored wherever
 * its sort_order happened to fall — so a category created after it appeared
 * *below* it, reading as a member of the same special group.
 *
 * `suggestedId` marks Time's guess where it already sits rather than promoting
 * it: classifying a run of rows is muscle memory, and a list that reorders
 * itself per row means the position just learned is wrong on the next one.
 * Marking is not selecting — the row's value stays empty, so no entry takes a
 * check and the trigger still reads "Classify".
 *
 * A suggested id naming no current category marks nothing, the same direction
 * starterSuggestions.ts fails in: the user's taxonomy wins.
 */
export function categoryDestinationOptions(
  categories: Category[],
  suggestedId?: number | null,
  { dividerOffset = 0 }: { dividerOffset?: number } = {},
): MenuOption[] {
  const destinations = [
    ...categories.filter((category) => !category.isIgnored),
    ...categories.filter((category) => category.isIgnored),
  ];
  const firstIgnored = destinations.findIndex((category) => category.isIgnored);
  return destinations.map((category, index) => ({
    value: String(category.id),
    label: category.name,
    dot: category.color,
    hint: suggestedId != null && category.id === suggestedId ? "suggested" : undefined,
    // Never on the opening entry, where a rule would sit against the top of the
    // listbox rather than between two things. `dividerOffset` accounts for
    // callers that prepend their own entries, so "first in the list" is judged
    // against the rendered menu and not against this slice of it.
    divider: index === firstIgnored && index + dividerOffset > 0,
  }));
}
