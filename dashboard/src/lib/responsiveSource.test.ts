import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const authoredComponents = import.meta.glob("../**/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

describe("responsive source contracts", () => {
  it("does not reintroduce authored interface text below 11px", () => {
    for (const [file, source] of Object.entries(authoredComponents)) {
      expect(source, file).not.toMatch(/text-\[(?:[0-9]|10(?:\.5)?)px\]/);
    }
  });

  it("keeps documented CSS media queries aligned with the shared thresholds", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../index.css", import.meta.url)),
      "utf8",
    );
    expect(css).toContain("@media (max-width: 639px)");
    expect(css).toContain("@media (min-width: 640px) and (max-width: 1007px)");
    expect(css).toContain("@media (min-width: 1008px) and (max-width: 1831px)");
    expect(css).toContain("@media (min-width: 1832px)");
  });

  it("keeps the app scrollbar visually subordinate at compact sizes", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../index.css", import.meta.url)),
      "utf8",
    );
    expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*6px/s);
  });
});
