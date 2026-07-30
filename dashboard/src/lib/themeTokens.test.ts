// The theme tokens are declared in index.css, so this reads that file rather
// than a TypeScript copy of it — a second copy is the thing most likely to drift.
//
// Two failures motivate these tests, and both are silent:
//
//   1. A token typo (`text-ink-1`, where only `ink`, `ink-2`, `ink-3` exist)
//      emits no CSS at all. The element inherits, which looks plausible, and in
//      one theme it can look correct.
//   2. A token declared for dark and forgotten for light falls back to its dark
//      value — light ink on a light surface, visible only if someone opens that
//      theme and looks at that component.
//
// Neither shows up in a typecheck or a build, so they are held here instead.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { tooltipStyle } from "./chartTheme";

const SRC = join(__dirname, "..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** Custom properties declared by every rule whose selector matches `selector`,
 *  later declarations winning, as the cascade would resolve them. */
function tokensFor(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Brace matching rather than a single regex: these blocks contain functions
  // with their own parentheses and, in @theme's case, nested comments.
  for (let at = 0; at < CSS.length; ) {
    const start = CSS.indexOf(selector, at);
    if (start === -1) break;
    const open = CSS.indexOf("{", start + selector.length);
    at = start + selector.length;
    // Only a rule whose selector *ends* here, so `:root` never matches
    // `:root[data-theme="light"]`.
    if (open === -1 || CSS.slice(start + selector.length, open).trim() !== "") continue;
    let depth = 1;
    let i = open + 1;
    for (; i < CSS.length && depth > 0; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}") depth--;
    }
    const body = CSS.slice(open + 1, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out[name] = value.trim();
    }
    at = i;
  }
  return out;
}

const DARK = { ...tokensFor("@theme"), ...tokensFor(":root") };
const LIGHT = { ...DARK, ...tokensFor(':root[data-theme="light"]') };
const THEMES = { dark: DARK, light: LIGHT } as const;

function channels(value: string): [number, number, number] {
  const hex = value.trim().replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Every --color-* token, so a new one cannot be added to one theme only. */
const COLOR_TOKENS = Object.keys(DARK).filter((name) => name.startsWith("--color-"));

// The floor each ink rank is pinned to, and the fills it is allowed to sit on.
// A rank appears against every surface the app actually composes it with, not
// only the one it was drawn against: --color-ink-3 was tuned on the card and
// still lands on the bare page in the waiting and error screens.
const CONTRAST_FLOORS: Array<{ ink: string; on: string[]; floor: number }> = [
  { ink: "--color-ink", on: ["--color-bg", "--color-surface", "--color-surface-dim", "--color-surface-2", "--color-surface-3"], floor: 7 },
  { ink: "--color-ink-2", on: ["--color-bg", "--color-surface", "--color-surface-dim"], floor: 4.5 },
  { ink: "--color-ink-3", on: ["--color-bg", "--color-surface", "--color-surface-dim"], floor: 4.5 },
  // The raised pair exists for exactly these fills; on the page they would be
  // the wrong rank, which is why they are separate tokens and not a tweak.
  { ink: "--color-ink-3-raised", on: ["--color-surface-2", "--color-surface-3"], floor: 4.5 },
  { ink: "--color-ink-2-raised", on: ["--color-surface-2", "--color-surface-3"], floor: 4.5 },
  { ink: "--color-on-accent", on: ["--color-accent"], floor: 4.5 },
  { ink: "--color-accent", on: ["--color-bg", "--color-surface", "--color-surface-dim"], floor: 4.5 },
  { ink: "--color-bad", on: ["--color-surface", "--color-surface-dim"], floor: 4.5 },
  { ink: "--color-good", on: ["--color-surface", "--color-surface-dim"], floor: 4.5 },
  // 3:1, not 4.5:1, and the two-tier rule in index.css is the reason: -data is
  // the fill tier — a bar, a chart mark, the liveness dot — which WCAG holds to
  // the graphical-object floor. Text and annotation dots use plain --color-good,
  // above, and are held to the text floor there.
  { ink: "--color-good-data", on: ["--color-surface", "--color-surface-dim"], floor: 3 },
  // The Top Apps bar fill: a graphic, held to the same 3:1 floor as -good-data
  // and split from --color-accent for the same reason.
  { ink: "--color-accent-data", on: ["--color-surface", "--color-surface-dim"], floor: 3 },
  // A 9px status dot, so the graphical floor applies to it too.
  { ink: "--color-warn", on: ["--color-surface", "--color-surface-dim"], floor: 3 },
  // The settings toggle's knob in its off state: a shape on the surface-2 track,
  // so the graphical floor rather than a text one. On is --color-on-accent over
  // --color-accent, covered above.
  { ink: "--color-ink-3", on: ["--color-surface-2"], floor: 3 },
];

describe("theme tokens", () => {
  it("declares a dark value for every token, since dark is the default", () => {
    expect(COLOR_TOKENS.length).toBeGreaterThan(15);
    for (const token of COLOR_TOKENS) expect(DARK[token]).toBeTruthy();
    for (const shadow of ["--shadow-menu", "--shadow-panel", "--shadow-control"]) {
      expect(DARK[shadow]).toBeTruthy();
      expect(LIGHT[shadow]).not.toBe(DARK[shadow]);
    }
  });

  // A token the light theme forgets does not fail — it silently keeps the dark
  // value, which is the one thing a light theme cannot afford.
  it("overrides every colour token in the light theme", () => {
    const missing = COLOR_TOKENS.filter((token) => LIGHT[token] === DARK[token]);
    expect(missing).toEqual([]);
  });

  it("keeps primary ink equally assertive on cards in both themes", () => {
    const darkRatio = contrast(DARK["--color-ink"], DARK["--color-surface"]);
    const lightRatio = contrast(LIGHT["--color-ink"], LIGHT["--color-surface"]);
    expect(lightRatio / darkRatio).toBeGreaterThanOrEqual(0.9);
    expect(lightRatio / darkRatio).toBeLessThanOrEqual(1.1);
  });

  it("keeps chart tooltip ink mirrored to the CSS theme", () => {
    expect(tooltipStyle("dark").textStyle.color).toBe(DARK["--color-ink"]);
    expect(tooltipStyle("light").textStyle.color).toBe(LIGHT["--color-ink"]);
  });

  it("separates controls from records only where the light theme needs it", () => {
    expect(DARK["--color-control"]).toBe(DARK["--color-surface-2"]);
    expect(DARK["--color-control-edge"]).toBe(DARK["--color-edge"]);
    expect(LIGHT["--color-control-edge"]).toBe(LIGHT["--color-edge-2"]);
    // Not the card (white was a correction that overshot, removing the fill
    // entirely) and not surface-2 (that collided with record rows) — its own
    // fill, reproducing dark's 1.09:1 control-vs-card ratio on light.
    expect(LIGHT["--color-control"]).not.toBe(LIGHT["--color-surface"]);
    expect(LIGHT["--color-control"]).not.toBe(LIGHT["--color-surface-2"]);
    expect(
      Math.round(contrast(LIGHT["--color-control"], LIGHT["--color-surface"]) * 100) / 100,
    ).toBe(1.09);
  });

  for (const [name, tokens] of Object.entries(THEMES)) {
    describe(name, () => {
      it.each(CONTRAST_FLOORS)("keeps $ink at $floor:1 on every fill it lands on", ({ ink, on, floor }) => {
        for (const surface of on) {
          expect(tokens[ink], ink).toBeTruthy();
          expect(tokens[surface], surface).toBeTruthy();
          const ratio = contrast(tokens[ink], tokens[surface]);
          expect(Math.round(ratio * 100) / 100, `${ink} on ${surface}`).toBeGreaterThanOrEqual(floor);
        }
      });

      // The reason the raised pair had to ship together. Pinned to surface-3,
      // ink-3-raised passes ink-2 on dark; without a re-pinned ink-2-raised the
      // quieter of the two ranks would be the more prominent one wherever they
      // sit together, which is every menu with a header.
      it("never inverts the ink ranks on a raised fill", () => {
        const distance = (token: string) =>
          Math.abs(luminance(tokens[token]) - luminance(tokens["--color-surface-3"]));
        expect(distance("--color-ink")).toBeGreaterThan(distance("--color-ink-2-raised"));
        expect(distance("--color-ink-2-raised")).toBeGreaterThan(distance("--color-ink-3-raised"));
      });

      it("keeps cards distinguishable from the page in the same direction", () => {
        // Light-card-on-tinted-page in both themes: the figure-ground reading
        // has to survive the switch, or every card border becomes load-bearing.
        const lift = luminance(tokens["--color-surface"]) - luminance(tokens["--color-bg"]);
        expect(lift).toBeGreaterThan(0);
      });

      // A control border is a hairline, so it is held to a floor of its own
      // rather than to a text ratio. The page reading is the one that matters:
      // the date range picker and the chart selectors sit directly on --color-bg
      // with no card behind them, and that is where the light theme first went
      // too faint to see — 1.19:1, against 1.39:1 for the same token on dark.
      // Two floors, not one, because the two backdrops are not the same problem.
      // On the page a border is the only thing separating a control from
      // nothing, and both themes must clear the same bar there. On a card the
      // fill already does part of the work, so the bar is lower — and dark
      // genuinely sits at 1.30 there, which reads fine: a light hairline on a
      // near-black card is more legible than the same ratio the other way up.
      it("keeps a control border visible against the page and the card", () => {
        for (const edge of ["--color-edge", "--color-edge-2"]) {
          for (const [behind, floor] of [["--color-bg", 1.35], ["--color-surface", 1.25]] as const) {
            const ratio = contrast(tokens[edge], tokens[behind]);
            expect(
              Math.round(ratio * 100) / 100,
              `${edge} on ${behind}`,
            ).toBeGreaterThanOrEqual(floor);
          }
        }
      });

      // Two edge ranks that read alike are one rank and a maintenance cost.
      // edge-2 is hover, and it has to be visibly more than rest.
      it("keeps the two edge ranks apart", () => {
        const step =
          contrast(tokens["--color-edge-2"], tokens["--color-surface"]) /
          contrast(tokens["--color-edge"], tokens["--color-surface"]);
        expect(step).toBeGreaterThan(1.1);
      });
    });
  }
});

// Finding 12: `text-ink-1` referenced a token that was never declared, so
// Tailwind emitted nothing and the heading quietly inherited its parent's
// colour. Nothing failed — not the build, not the typecheck, and not the eye,
// because inheriting from a heading's parent looks deliberate.
describe("colour utilities in components", () => {
  const FILES = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  // Utilities that take a colour token, with Tailwind's optional variant prefix
  // (`hover:`, `sm:`, `group-focus:`) and opacity suffix (`/40`, `/[.06]`).
  const UTILITY = /(?:^|[\s"'`:])(?:text|bg|border|from|to|via|fill|stroke|ring|outline|decoration|shadow|divide|accent|caret|placeholder)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/(?:\[[^\]]*\]|\d+))?(?=$|[\s"'`])/g;

  // Tailwind's own palette and keywords, which are not app tokens. The single
  // letters are the side suffixes — `border-b`, `border-x` — which share a
  // prefix with the colour utilities but name an edge, not a colour.
  const BUILT_IN = new Set([
    "white", "black", "transparent", "current", "inherit", "none", "auto",
    "solid", "dashed", "dotted", "double", "hidden", "offset", "clip", "ellipsis",
    "left", "right", "center", "top", "bottom", "start", "end", "justify", "wrap",
    "nowrap", "balance", "pretty", "reverse", "gradient",
    "b", "t", "l", "r", "x", "y", "s", "e",
  ]);

  it("references only colour tokens that exist", () => {
    const unresolved = new Map<string, string[]>();
    for (const [path, source] of Object.entries(FILES)) {
      if (path.includes(".test.")) continue;
      for (const [, name] of source.matchAll(UTILITY)) {
        if (BUILT_IN.has(name) || name.startsWith("[")) continue;
        // A size or geometry step sharing a utility prefix (`border-2`,
        // `shadow-menu`, `text-xs`) is not a colour reference.
        if (`--color-${name}` in DARK) continue;
        if (!COLOR_TOKENS.some((token) => token.startsWith(`--color-${name.split("-")[0]}`))) continue;
        unresolved.set(name, [...(unresolved.get(name) ?? []), path]);
      }
    }
    expect(Object.fromEntries(unresolved)).toEqual({});
  });
});
