import { describe, expect, it } from "vitest";

import { tabForShortcut, tabShortcutLabel, type ShortcutKey } from "./tabShortcuts";

const TABS = ["insights", "activity", "settings"] as const;

function press(key: string, code: string, mods: Partial<ShortcutKey> = {}): ShortcutKey {
  return { key, code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("tabForShortcut", () => {
  it("jumps to a tab by its position", () => {
    expect(tabForShortcut(press("1", "Digit1"), TABS, "settings")).toBe("insights");
    expect(tabForShortcut(press("3", "Digit3"), TABS, "insights")).toBe("settings");
  });

  it("reads the physical digit, so AZERTY and the numpad work too", () => {
    expect(tabForShortcut(press("&", "Digit1"), TABS, "activity")).toBe("insights");
    expect(tabForShortcut(press("2", "Numpad2"), TABS, "insights")).toBe("activity");
  });

  it("ignores digits past the last tab", () => {
    expect(tabForShortcut(press("4", "Digit4"), TABS, "insights")).toBeNull();
    expect(tabForShortcut(press("0", "Digit0"), TABS, "insights")).toBeNull();
  });

  it("steps forward and back with wrapping", () => {
    expect(tabForShortcut(press("Tab", "Tab"), TABS, "insights")).toBe("activity");
    expect(tabForShortcut(press("Tab", "Tab"), TABS, "settings")).toBe("insights");
    expect(tabForShortcut(press("Tab", "Tab", { shiftKey: true }), TABS, "insights")).toBe("settings");
  });

  it("needs Ctrl and nothing else", () => {
    expect(tabForShortcut(press("1", "Digit1", { ctrlKey: false }), TABS, "settings")).toBeNull();
    expect(tabForShortcut(press("1", "Digit1", { altKey: true }), TABS, "settings")).toBeNull();
    expect(tabForShortcut(press("1", "Digit1", { metaKey: true }), TABS, "settings")).toBeNull();
    expect(tabForShortcut(press("!", "Digit1", { shiftKey: true }), TABS, "settings")).toBeNull();
    expect(tabForShortcut(press("Tab", "Tab", { ctrlKey: false }), TABS, "settings")).toBeNull();
  });

  it("leaves other Ctrl shortcuts alone", () => {
    expect(tabForShortcut(press("c", "KeyC"), TABS, "insights")).toBeNull();
  });
});

describe("tabShortcutLabel", () => {
  it("numbers from one", () => {
    expect(tabShortcutLabel(0)).toBe("Ctrl+1");
  });
});
