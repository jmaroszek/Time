// A border means "this holds a value": a field, a menu trigger, the selected
// tile in a picker. Buttons hold none, so none of them draws one. This keeps it
// that way.
//
// The app got to a mix without anyone deciding on one. Settings dropped its
// bordered buttons for text actions, the rule composer followed, and every other
// screen kept boxes — so the same Cancel was outlined in one dialog and bare
// text in the inline form beside it. Nothing catches that: each one renders
// correctly on its own. The only way it stays settled is if adding a bordered
// button fails.

import { describe, expect, it } from "vitest";

const FILES = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const components = Object.entries(FILES).filter(([path]) => !path.includes(".test."));

/** The controls that are buttons in the DOM but values in the design, each
 *  border drawing a state the reader has to see. Counted per file, so a new
 *  bordered button in one of these files still fails. */
const VALUE_CONTROLS: Record<string, number> = {
  // The select trigger, which shows the value it holds.
  "../components/ui/MenuSelect.tsx": 1,
  // The restore dialog's list of backups, a radio group.
  "../tabs/settings/DataSection.tsx": 1,
  // The browser-process and media-site chips: each is an entered value.
  "../tabs/settings/fields.tsx": 1,
  // The weekday picker and the palette tiles.
  "../tabs/SettingsTab.tsx": 2,
};

/** A border colour, which is what makes a border visible. `border-transparent`
 *  is not one: Button keeps a transparent border so it matches a MenuSelect
 *  trigger's height where the two share a row. */
const BORDER_COLOR = /(?<![\w-])border-(?!transparent\b|0\b|none\b|solid\b|dashed\b|[trblxy]\b|[trblxy]-0\b)[a-z][\w-]*(?:\/[\w.[\]]+)?/;

/** Every opening `<button>` and `<Button>` tag in a source file, with whatever
 *  expressions sit between its braces — enough to see each class it can take. */
function openingTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<(?:button|Button)\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    let end = match.index + 1;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote && source[end - 1] !== "\\") quote = null;
      } else if (char === '"' || char === "'" || char === "`") {
        // Outside braces only a double quote opens an attribute string; an
        // apostrophe there is text, as in a component's children.
        if (depth > 0 || char === '"') quote = char;
      } else if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }
    tags.push(source.slice(match.index, end + 1));
  }
  return tags;
}

describe("button borders", () => {
  it("draws no border on a button outside the listed value controls", () => {
    const offenders: string[] = [];
    for (const [path, source] of components) {
      const bordered = openingTags(source).filter((tag) => BORDER_COLOR.test(tag));
      const allowed = VALUE_CONTROLS[path] ?? 0;
      if (bordered.length > allowed) {
        offenders.push(...bordered.map((tag) => `${path}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives no Button variant a border colour", () => {
    // The variants live in a lookup rather than on the tag, so the scan above
    // cannot see them.
    const button = FILES["../components/ui/Button.tsx"];
    const styles = /const styles = \{([\s\S]*?)\}\[variant\]/.exec(button);
    expect(styles).not.toBeNull();
    expect(styles![1]).not.toMatch(BORDER_COLOR);
  });

  it("still lists only files that exist", () => {
    // A renamed file would otherwise leave its allowance behind, quietly
    // granting it to nothing while the moved controls fail somewhere else.
    for (const path of Object.keys(VALUE_CONTROLS)) expect(FILES[path]).toBeDefined();
  });
});
