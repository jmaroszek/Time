import { describe, expect, it } from "vitest";

import { aggregateBlocks } from "./blocks";
import { buildClassifier, type Category, type Rule } from "./classify";
import type { Session } from "./metrics";

const CATS: Category[] = [
  { id: 1, name: "Notes", color: "#7F77DD", isProductive: true, isIgnored: false, sortOrder: 1 },
  { id: 2, name: "AI tools", color: "#1D9E75", isProductive: true, isIgnored: false, sortOrder: 2 },
];
const RULES: Rule[] = [
  { id: 1, matchType: "process", pattern: "obsidian.exe", categoryId: 1, priority: 100 },
  { id: 2, matchType: "process", pattern: "claude.exe", categoryId: 2, priority: 100 },
];
const classify = buildClassifier(CATS, RULES, new Set());

const DAY = new Date(2026, 5, 8); // Mon Jun 8 2026 local midnight
const T0 = DAY.getTime() / 1000;
const RANGE = { start: DAY, end: new Date(2026, 5, 9) };

let id = 1;
function sess(start: number, end: number, process = "obsidian.exe", isAfk = false): Session {
  return { id: id++, start, end, process, title: "", domain: null, isAfk };
}

describe("aggregateBlocks", () => {
  it("colors a block by its dominant category and breaks down apps", () => {
    // 9:00-9:10 obsidian (10m), 9:10-9:14 claude (4m) in a 15m block
    const blocks = aggregateBlocks(
      [sess(T0 + 9 * 3600, T0 + 9 * 3600 + 600), sess(T0 + 9 * 3600 + 600, T0 + 9 * 3600 + 840, "claude.exe")],
      RANGE,
      classify,
      15,
    );
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.categoryName).toBe("Notes");
    expect(b.color).toBe("#7F77DD");
    expect(b.startHour).toBe(9);
    expect(b.endHour).toBe(9.25);
    expect(b.activeSec).toBe(840);
    expect(b.apps[0]).toEqual({ process: "obsidian.exe", seconds: 600 });
    expect(b.apps[1]).toEqual({ process: "claude.exe", seconds: 240 });
  });

  it("splits long sessions across block boundaries", () => {
    // 2h continuous session -> 8 contiguous 15m blocks, same color
    const blocks = aggregateBlocks([sess(T0 + 10 * 3600, T0 + 12 * 3600)], RANGE, classify, 15);
    expect(blocks).toHaveLength(8);
    expect(new Set(blocks.map((b) => b.categoryName))).toEqual(new Set(["Notes"]));
    expect(blocks[0].startHour).toBe(10);
    expect(blocks[7].endHour).toBe(12);
  });

  it("drops blocks with negligible activity", () => {
    // 20s of activity in a 15m block (< 5%)
    const blocks = aggregateBlocks([sess(T0 + 9 * 3600, T0 + 9 * 3600 + 20)], RANGE, classify, 15);
    expect(blocks).toHaveLength(0);
  });

  it("renders mostly-afk blocks as AFK", () => {
    const blocks = aggregateBlocks(
      [sess(T0 + 9 * 3600, T0 + 9 * 3600 + 800, "afk", true)],
      RANGE,
      classify,
      15,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isAfk).toBe(true);
    expect(blocks[0].categoryName).toBe("AFK");
  });

  it("active time wins over afk inside the same block", () => {
    const blocks = aggregateBlocks(
      [
        sess(T0 + 9 * 3600, T0 + 9 * 3600 + 500, "afk", true),
        sess(T0 + 9 * 3600 + 500, T0 + 9 * 3600 + 900, "obsidian.exe"),
      ],
      RANGE,
      classify,
      15,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isAfk).toBe(false);
    expect(blocks[0].activeSec).toBe(400);
  });

  it("uncategorized processes still form blocks", () => {
    const blocks = aggregateBlocks(
      [sess(T0 + 9 * 3600, T0 + 10 * 3600, "mystery.exe")],
      RANGE,
      classify,
      15,
    );
    expect(blocks[0].categoryName).toBe("Uncategorized");
  });

  it("orders blocks by day then hour", () => {
    const range2 = { start: DAY, end: new Date(2026, 5, 10) };
    const t1 = new Date(2026, 5, 9).getTime() / 1000;
    const blocks = aggregateBlocks(
      [sess(t1 + 3600, t1 + 4500), sess(T0 + 7200, T0 + 8100)],
      range2,
      classify,
      15,
    );
    expect(blocks[0].dayKey).toBe("2026-06-08");
    expect(blocks[blocks.length - 1].dayKey).toBe("2026-06-09");
  });
});
