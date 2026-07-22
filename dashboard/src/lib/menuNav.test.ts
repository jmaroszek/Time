import { describe, expect, it } from "vitest";

import { moveIndex, typeaheadIndex } from "./menuNav";

describe("moveIndex", () => {
  it("steps down and up", () => {
    expect(moveIndex("ArrowDown", 0, 5)).toBe(1);
    expect(moveIndex("ArrowUp", 3, 5)).toBe(2);
  });

  it("clamps rather than wrapping", () => {
    expect(moveIndex("ArrowDown", 4, 5)).toBe(4);
    expect(moveIndex("ArrowUp", 0, 5)).toBe(0);
  });

  it("enters an inactive list from the matching end", () => {
    expect(moveIndex("ArrowDown", -1, 5)).toBe(0);
    expect(moveIndex("ArrowUp", -1, 5)).toBe(4);
  });

  it("jumps to either end", () => {
    expect(moveIndex("Home", 3, 5)).toBe(0);
    expect(moveIndex("End", 1, 5)).toBe(4);
  });

  it("ignores keys it does not own", () => {
    expect(moveIndex("Enter", 1, 5)).toBeNull();
    expect(moveIndex("a", 1, 5)).toBeNull();
  });

  it("has nowhere to go in an empty list", () => {
    expect(moveIndex("ArrowDown", -1, 0)).toBeNull();
    expect(moveIndex("Home", -1, 0)).toBeNull();
  });

  it("recovers when the active index outruns a shortened list", () => {
    expect(moveIndex("ArrowDown", 9, 3)).toBe(2);
    expect(moveIndex("ArrowUp", 9, 3)).toBe(1);
  });
});

describe("typeaheadIndex", () => {
  const presets = ["Today", "Week", "Month", "Quarter", "Year", "All time", "Custom"];

  it("finds a unique prefix from anywhere in the list", () => {
    expect(typeaheadIndex(presets, "q", 0)).toBe(3);
    expect(typeaheadIndex(presets, "cu", 5)).toBe(6);
  });

  it("is case insensitive", () => {
    expect(typeaheadIndex(presets, "YE", 0)).toBe(4);
  });

  it("wraps past the end", () => {
    expect(typeaheadIndex(presets, "t", 5)).toBe(0);
  });

  it("keeps a growing buffer on the entry it already matched", () => {
    // "m" lands on Month; typing "o" after it must not skip to the next M.
    expect(typeaheadIndex(presets, "mo", 2)).toBe(2);
  });

  it("cycles between entries sharing an initial when the key repeats", () => {
    const months = ["March", "May", "June"];
    expect(typeaheadIndex(months, "m", -1)).toBe(0);
    expect(typeaheadIndex(months, "mm", 0)).toBe(1);
    expect(typeaheadIndex(months, "mmm", 1)).toBe(0);
  });

  it("returns null when nothing matches or there is nothing to match", () => {
    expect(typeaheadIndex(presets, "z", 0)).toBeNull();
    expect(typeaheadIndex(presets, "", 0)).toBeNull();
    expect(typeaheadIndex([], "a", -1)).toBeNull();
  });
});
