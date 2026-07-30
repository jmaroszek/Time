// The type scale is six steps plus the KPI figure, declared in index.css. This
// keeps the set closed.
//
// It got to fourteen sizes without anyone deciding to have fourteen: Tailwind
// makes `text-[12.5px]` as easy to write as `text-xs`, so each new component
// picked whatever looked right on its own, and the result was pairs half a pixel
// apart. Nothing catches that — every one of them renders correctly. The only
// way it stays at six is if adding a seventh fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** The utilities allowed to set a font size, and the size each one means.
 *  Tailwind's own steps are listed by the value they resolve to, so a reader can
 *  see the scale here without cross-referencing Tailwind's defaults. */
const SCALE: Record<string, number> = {
  "text-micro": 10.5,
  "text-meta": 11.5,
  "text-xs": 12,
  "text-row": 13,
  "text-sm": 14,
  "text-lg": 18,
  "text-2xl": 24,
};

const FILES = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const components = Object.entries(FILES).filter(([path]) => !path.includes(".test."));

describe("type scale", () => {
  it("declares the three steps Tailwind has no default for", () => {
    for (const [name, size] of Object.entries(SCALE)) {
      if (!name.startsWith("text-micro") && !name.startsWith("text-meta") && !name.startsWith("text-row")) continue;
      expect(CSS).toContain(`--${name.replace("text-", "text-")}: ${size}px;`);
    }
  });

  // Any `text-[13px]`-style value is off the scale by construction: if the size
  // were on it, there would be a named step to use instead.
  it("uses no arbitrary font sizes", () => {
    const offenders: string[] = [];
    for (const [path, source] of components) {
      for (const [match] of source.matchAll(/text-\[[\d.]+(?:px|rem|em)\]/g)) {
        offenders.push(`${path}: ${match}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no font-size utility outside the scale", () => {
    // Tailwind's other size steps exist and are one keystroke away; these are the
    // ones the scale does not include.
    const OFF_SCALE = ["text-base", "text-xl", "text-3xl", "text-4xl", "text-5xl", "text-\\[length"];
    const offenders: string[] = [];
    for (const [path, source] of components) {
      for (const name of OFF_SCALE) {
        const pattern = new RegExp(`(?:^|[\\s"'\`:])${name}(?=$|[\\s"'\`])`, "g");
        if (pattern.test(source)) offenders.push(`${path}: ${name.replace("\\\\", "")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the chart axis size on the metadata step", () => {
    // ECharts takes a number, not a class, so this one has to be checked against
    // the scale rather than being expressed in it.
    const chartTheme = readFileSync(join(SRC, "lib", "chartTheme.ts"), "utf8");
    const declared = /CHART_LABEL_SIZE = ([\d.]+)/.exec(chartTheme);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(SCALE["text-meta"]);
  });

  it("has nothing below 10.5px", () => {
    expect(Math.min(...Object.values(SCALE))).toBe(10.5);
  });
});
