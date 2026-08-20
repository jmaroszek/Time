import { describe, expect, it } from "vitest";

import type { Category } from "../../lib/classify";
import { categoryDestinationOptions } from "./menuOptions";

function category(id: number, name: string, overrides: Partial<Category> = {}): Category {
  return {
    id,
    name,
    color: `#${id}${id}${id}`,
    isProductive: false,
    isNeutral: true,
    isIgnored: false,
    sortOrder: id,
    ...overrides,
  };
}

const SEEDED: Category[] = [
  category(1, "Work", { isProductive: true, isNeutral: false }),
  category(2, "Communication"),
  category(4, "Entertainment", { isNeutral: false }),
  category(5, "System"),
  category(6, "Ignored", { isNeutral: false, isIgnored: true }),
];

const ORDER = ["Work", "Communication", "Entertainment", "System", "Ignored"];

describe("triage destinations", () => {
  it("lists every category, ignored ones last behind a rule", () => {
    const options = categoryDestinationOptions(SEEDED);
    expect(options.map((option) => option.label)).toEqual(ORDER);
    expect(options.find((option) => option.label === "Ignored")?.divider).toBe(true);
    expect(options.filter((option) => option.divider)).toHaveLength(1);
  });

  it("carries each category's colour so the menu can draw its dot", () => {
    const options = categoryDestinationOptions(SEEDED);
    expect(options.find((option) => option.label === "System")?.dot).toBe("#555");
  });

  it("keeps Ignored last even when it sorts before a newer category", () => {
    // What the row-detail menus got wrong: they rendered stored order, so a
    // category created after Ignored appeared below it and read as a second
    // member of Ignored's special group.
    const withNewer = [...SEEDED, category(7, "Reading", { sortOrder: 7 })];
    const options = categoryDestinationOptions(withNewer);
    expect(options.map((option) => option.label))
      .toEqual(["Work", "Communication", "Entertainment", "System", "Reading", "Ignored"]);
    expect(options[options.length - 1]?.divider).toBe(true);
  });

  it("does not put a divider on the opening entry", () => {
    // A rule against the top of the listbox separates nothing.
    const ignoredFirst = [category(6, "Ignored", { isIgnored: true }), category(1, "Work")];
    const options = categoryDestinationOptions(ignoredFirst);
    expect(options.map((option) => option.label)).toEqual(["Work", "Ignored"]);
    expect(options[0]?.divider).toBeFalsy();
  });

  it("offsets the divider for a caller that prepends its own entry", () => {
    // With something already above it, an Ignored entry that lands first in this
    // slice still needs its rule -- the menu has a line above it.
    const onlyIgnored = [category(6, "Ignored", { isIgnored: true })];
    expect(categoryDestinationOptions(onlyIgnored)[0]?.divider).toBeFalsy();
    expect(categoryDestinationOptions(onlyIgnored, null, { dividerOffset: 1 })[0]?.divider)
      .toBe(true);
  });
});

describe("a marked suggestion", () => {
  // The point of the mark. Reordering to put the guess first made every menu a
  // different menu, which is the one thing a list being classified down cannot
  // afford — see the note in menuOptions.ts.
  it("does not disturb the order", () => {
    for (const suggested of [null, 1, 2, 4, 5, 6]) {
      const options = categoryDestinationOptions(SEEDED, suggested);
      expect(options.map((option) => option.label)).toEqual(ORDER);
    }
  });

  it("marks the suggested category and nothing else", () => {
    const options = categoryDestinationOptions(SEEDED, 5);
    expect(options.filter((option) => option.hint)).toHaveLength(1);
    expect(options.find((option) => option.label === "System")?.hint).toBe("suggested");
  });

  it("leaves the rule above the ignored group where it was", () => {
    const options = categoryDestinationOptions(SEEDED, 5);
    expect(options.find((option) => option.label === "Ignored")?.divider).toBe(true);
    expect(options.filter((option) => option.divider)).toHaveLength(1);
  });

  // The rename and delete cases arrive here as an id naming nothing, because
  // resolveRoleCategories has already refused to follow the category. Marking a
  // stale id would put "suggested" on nothing at best, and on whichever
  // category later reused the id at worst.
  it("marks nothing when the suggested category is gone", () => {
    const withoutSystem = SEEDED.filter((entry) => entry.name !== "System");
    const options = categoryDestinationOptions(withoutSystem, 5);
    expect(options.map((option) => option.label)).toEqual([
      "Work",
      "Communication",
      "Entertainment",
      "Ignored",
    ]);
    expect(options.some((option) => option.hint)).toBe(false);
  });

  it("marks nothing when there is no suggestion at all", () => {
    for (const absent of [null, undefined]) {
      expect(categoryDestinationOptions(SEEDED, absent).some((option) => option.hint)).toBe(false);
    }
  });
});
