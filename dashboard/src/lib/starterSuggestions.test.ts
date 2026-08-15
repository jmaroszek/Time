import { describe, expect, it } from "vitest";

import { DEFAULT_BROWSER_PROCESSES, normalizeBrowserProcesses } from "./browsers";
import type { Category } from "./classify";
import {
  RECOGNIZED_NOT_SUGGESTED,
  STARTER_APPS,
  resolveRoleCategories,
  roleForProcess,
  suggestForTriage,
  suggestionKey,
  type SuggestibleEntity,
} from "./starterSuggestions";

function category(id: number, name: string, overrides: Partial<Category> = {}): Category {
  return {
    id,
    name,
    color: "#000",
    isProductive: false,
    isNeutral: true,
    isIgnored: false,
    sortOrder: id,
    ...overrides,
  };
}

/** The taxonomy a fresh install seeds. */
const SEEDED: Category[] = [
  category(1, "Work", { isProductive: true, isNeutral: false }),
  category(2, "Communication"),
  category(3, "Browsing"),
  category(4, "Entertainment", { isNeutral: false }),
  category(5, "System"),
  category(6, "Ignored", { isNeutral: false, isIgnored: true }),
];

const BROWSERS = new Set(normalizeBrowserProcesses(DEFAULT_BROWSER_PROCESSES));

function app(key: string): SuggestibleEntity {
  return { kind: "app", key };
}

function suggest(
  entities: SuggestibleEntity[],
  categories: Category[] = SEEDED,
  dismissed: Set<string> = new Set(),
) {
  return suggestForTriage(entities, categories, dismissed, BROWSERS);
}

describe("the catalog itself", () => {
  // The load-bearing one. A browser in the catalog would file every site visited
  // inside it under one category and take the browser out of the queue that
  // would have prompted the correction — the single failure this feature could
  // cause that the user would never be shown.
  it("never names a browser", () => {
    for (const process of BROWSERS) {
      expect(STARTER_APPS[process], `${process} must not be suggestible`).toBeUndefined();
    }
  });

  it("lists every default browser as recognized but unsuggested", () => {
    for (const process of BROWSERS) {
      expect(RECOGNIZED_NOT_SUGGESTED.has(process), `${process} should be listed`).toBe(true);
    }
  });

  it("shares no process between the catalog and the recognized list", () => {
    for (const process of RECOGNIZED_NOT_SUGGESTED) {
      expect(STARTER_APPS[process]).toBeUndefined();
    }
  });

  it("stores names the way sessions and App rules do", () => {
    for (const process of Object.keys(STARTER_APPS)) {
      expect(process).toBe(process.toLowerCase());
      expect(process.endsWith(".exe")).toBe(true);
    }
  });

  // App rules match an exact normalized executable name, so a version-bearing
  // entry could only ever match the one build it was written against.
  it("carries no version-bearing names", () => {
    for (const process of Object.keys(STARTER_APPS)) {
      expect(process, `${process} looks version-stamped`).not.toMatch(/\d+\.\d+/);
    }
  });

  // javaw.exe is Minecraft, and every other Java application ever shipped.
  it("names no shared runtime host", () => {
    for (const host of ["javaw.exe", "java.exe", "python.exe", "pythonw.exe", "electron.exe"]) {
      expect(STARTER_APPS[host], `${host} could be anything`).toBeUndefined();
    }
  });
});

describe("resolving roles to categories", () => {
  it("points every role somewhere in the seeded taxonomy", () => {
    const resolved = resolveRoleCategories(SEEDED);
    expect(resolved.get("development")).toBe(1);
    expect(resolved.get("writing")).toBe(1);
    expect(resolved.get("creative")).toBe(1);
    expect(resolved.get("study")).toBe(1);
    expect(resolved.get("messaging")).toBe(2);
    expect(resolved.get("gaming")).toBe(4);
    expect(resolved.get("media")).toBe(4);
    expect(resolved.get("system")).toBe(5);
    expect(resolved.get("plumbing")).toBe(6);
  });

  it("does not follow a starter category after it is renamed", () => {
    const resolved = resolveRoleCategories([
      category(1, "Deep Work", { isProductive: true, isNeutral: false }),
      category(2, "Comms"),
    ]);
    expect(resolved.get("development")).toBeUndefined();
    expect(resolved.get("messaging")).toBeUndefined();
  });

  it("uses the exact starter category when a synonymous custom category also exists", () => {
    const resolved = resolveRoleCategories([
      category(1, "Focus", { isProductive: true, isNeutral: false }),
      category(2, "Work", { isProductive: true, isNeutral: false }),
    ]);
    expect(resolved.get("development")).toBe(2);
  });

  // A taxonomy Time does not recognize is one the user has made their own.
  it("resolves nothing for names outside the starter taxonomy", () => {
    const resolved = resolveRoleCategories([category(1, "Client billable")]);
    expect(resolved.size).toBe(0);
  });

  it("treats renaming a starter category as declining its suggestions", () => {
    const renamedSystem = SEEDED.map((candidate) =>
      candidate.name === "System" ? { ...candidate, name: "Utilities" } : candidate,
    );
    expect(suggestForTriage(
      [app("explorer.exe")],
      renamedSystem,
      new Set(),
      BROWSERS,
    )).toEqual([]);
  });

  // Hiding time is a stronger act than filing it.
  it("refuses to point a normal role at an ignored category", () => {
    const resolved = resolveRoleCategories([
      category(1, "Work", { isIgnored: true }),
      category(2, "Ignored", { isIgnored: true }),
    ]);
    expect(resolved.has("development")).toBe(false);
    expect(resolved.get("plumbing")).toBe(2);
  });
});

describe("suggesting", () => {
  it("suggests a catalogued app", () => {
    expect(suggest([app("slack.exe")])).toEqual([
      { entity: app("slack.exe"), categoryId: 2 },
    ]);
  });

  it("matches case-insensitively", () => {
    expect(suggest([app("Slack.EXE")])[0]?.categoryId).toBe(2);
  });

  it("recognizes an Unreal Engine build nobody has catalogued", () => {
    expect(suggest([app("sandfall-win64-shipping.exe")])[0]?.categoryId).toBe(4);
  });

  it("recognizes an anti-cheat launcher as the game it guards", () => {
    expect(suggest([app("rocketleague_eac.exe")])[0]?.categoryId).toBe(4);
    expect(suggest([app("start_protected_game.exe")])[0]?.categoryId).toBe(4);
  });

  it("never suggests for a browser, listed or configured", () => {
    expect(suggest([app("chrome.exe")])).toEqual([]);
    // A browser this user added by hand is as untouchable as a shipped one.
    expect(
      suggestForTriage([app("thorium.exe")], SEEDED, new Set(), new Set(["thorium.exe"])),
    ).toEqual([]);
  });

  it("never suggests for a bimodal app", () => {
    expect(suggest([app("discord.exe")])).toEqual([]);
    expect(suggest([app("obs64.exe")])).toEqual([]);
  });

  it("says nothing about an app it does not know", () => {
    expect(suggest([app("r5apex_dx12.exe")])).toEqual([]);
    expect(suggest([app("fire.exe")])).toEqual([]);
  });

  it("leaves websites alone", () => {
    expect(suggest([{ kind: "website", key: "youtube.com" }])).toEqual([]);
  });

  // A suggestion that returns after being turned down is what makes the next one
  // not worth reading.
  it("stays quiet once dismissed", () => {
    const dismissed = new Set([suggestionKey(app("slack.exe"))]);
    expect(suggest([app("slack.exe")], SEEDED, dismissed)).toEqual([]);
  });

  it("keeps app and website dismissals apart", () => {
    expect(suggestionKey(app("steam.exe"))).toBe("app:steam.exe");
    expect(suggestionKey({ kind: "website", key: "Steam.com" })).toBe("website:steam.com");
  });

  it("suggests nothing when the target category is gone", () => {
    const withoutComms = SEEDED.filter((c) => c.name !== "Communication");
    expect(suggest([app("slack.exe")], withoutComms)).toEqual([]);
    // …while roles that still resolve keep working.
    expect(suggest([app("code.exe")], withoutComms)[0]?.categoryId).toBe(1);
  });

  it("suggests nothing when System was deleted or renamed", () => {
    const withoutSystem = SEEDED.filter((c) => c.name !== "System");
    expect(suggest([app("explorer.exe")], withoutSystem)).toEqual([]);

    const renamedSystem = SEEDED.map((candidate) =>
      candidate.name === "System" ? { ...candidate, name: "Utilities" } : candidate,
    );
    expect(suggest([app("explorer.exe")], renamedSystem)).toEqual([]);
  });

  it("suggests nothing at all when the user declined the starter categories", () => {
    const onlyIgnored = [category(6, "Ignored", { isNeutral: false, isIgnored: true })];
    expect(suggest([app("slack.exe"), app("code.exe"), app("steam.exe")], onlyIgnored))
      .toEqual([]);
  });

  it("routes plumbing to Ignored rather than to a visible category", () => {
    expect(suggest([app("dwm.exe")])[0]?.categoryId).toBe(6);
  });

  it("keeps system tools visible instead of hiding them", () => {
    expect(suggest([app("explorer.exe")])[0]?.categoryId).toBe(5);
  });
});

describe("roleForProcess", () => {
  it("reads a catalogued name and a shaped one alike", () => {
    expect(roleForProcess("winword.exe")).toBe("writing");
    expect(roleForProcess("b1-win64-shipping.exe")).toBe("gaming");
    expect(roleForProcess("")).toBeNull();
    expect(roleForProcess("something-nobody-ships.exe")).toBeNull();
  });
});
