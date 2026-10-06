import { describe, expect, it } from "vitest";

import {
  RUN_GAP_TOLERANCE_SECONDS,
  RUN_GLANCE_SECONDS,
  collectRuns,
  orderedByStart,
  runNeighbors,
  runStats,
  timeWeightedMedian,
  type RunRowKind,
} from "./runs";

/** A timeline row: `kind` is what it is to the subject being traced. */
interface Row {
  id: number;
  start: number;
  end: number;
  kind: RunRowKind;
  name: string;
}

let nextId = 1;
/** Rows laid end to end from `at`, each `[kind, seconds, name?]`; "gap" leaves
 *  that many seconds with nothing recorded. */
function timeline(at: number, ...spans: Array<[RunRowKind | "gap", number, string?]>): Row[] {
  const rows: Row[] = [];
  let cursor = at;
  for (const [kind, seconds, name] of spans) {
    if (kind !== "gap") {
      rows.push({ id: nextId++, start: cursor, end: cursor + seconds, kind, name: name ?? kind });
    }
    cursor += seconds;
  }
  return rows;
}
const kindOf = (row: Row) => row.kind;
const lengths = (rows: Row[], startSec = 0, endSec = 1e9) =>
  collectRuns(rows, kindOf, startSec, endSec).map((run) => run.seconds);

describe("collectRuns", () => {
  it("joins the rows the tracker split on title changes", () => {
    expect(lengths(timeline(0, ["in", 600], ["in", 1200]))).toEqual([1800]);
  });

  it("carries a run across a glance elsewhere, without counting the glance", () => {
    expect(lengths(timeline(0, ["in", 600], ["other", RUN_GLANCE_SECONDS], ["in", 600])))
      .toEqual([1200]);
  });

  it("ends a run at a stop elsewhere longer than a glance", () => {
    expect(lengths(timeline(0, ["in", 600], ["other", RUN_GLANCE_SECONDS + 1], ["in", 600])))
      .toEqual([600, 600]);
  });

  it("carries a run across several glances, but not past the gap tolerance", () => {
    // Three ten-second glances are thirty seconds away: back in time.
    expect(lengths(timeline(
      0,
      ["in", 600],
      ["other", 10, "chat"],
      ["other", 10, "music"],
      ["other", RUN_GAP_TOLERANCE_SECONDS - 20, "files"],
      ["in", 600],
    ))).toEqual([1200]);
    // One second more and the reader had left, however short each stop was.
    expect(lengths(timeline(
      0,
      ["in", 600],
      ["other", 10, "chat"],
      ["other", 10, "music"],
      ["other", RUN_GAP_TOLERANCE_SECONDS - 19, "files"],
      ["in", 600],
    ))).toEqual([600, 600]);
  });

  it("ends a run at idle time, however brief", () => {
    expect(lengths(timeline(0, ["in", 600], ["idle", 2], ["in", 600]))).toEqual([600, 600]);
  });

  it("spans a short unrecorded seam but not a long one", () => {
    expect(lengths(timeline(0, ["in", 600], ["gap", RUN_GAP_TOLERANCE_SECONDS], ["in", 600])))
      .toEqual([1200]);
    expect(lengths(timeline(0, ["in", 600], ["gap", RUN_GAP_TOLERANCE_SECONDS + 1], ["in", 600])))
      .toEqual([600, 600]);
  });

  it("treats unrecorded rows as nothing at all, so only their length matters", () => {
    expect(lengths(timeline(0, ["in", 600], ["unrecorded", 25], ["in", 600]))).toEqual([1200]);
    expect(lengths(timeline(0, ["in", 600], ["unrecorded", 120], ["in", 600]))).toEqual([600, 600]);
  });

  it("counts only the part of a run inside the range", () => {
    expect(lengths(timeline(0, ["in", 3600], ["in", 3600]), 1800, 5400)).toEqual([3600]);
  });

  it("adds up to the subject's own time", () => {
    const rows = timeline(
      0,
      ["in", 300], ["other", 5], ["in", 200], ["other", 400], ["in", 100],
      ["idle", 60], ["in", 50], ["gap", 10], ["in", 70],
    );
    const runs = collectRuns(rows, kindOf, 0, 1e9);
    expect(runs.reduce((total, run) => total + run.seconds, 0)).toBe(300 + 200 + 100 + 50 + 70);
    expect(runs.map(({ first, last }) => [first, last])).toEqual([[0, 2], [4, 4], [6, 7]]);
  });

  it("has no runs without the subject", () => {
    expect(lengths(timeline(0, ["other", 600], ["idle", 60]))).toEqual([]);
  });
});

describe("orderedByStart", () => {
  it("sorts only when it has to", () => {
    const sorted = timeline(0, ["in", 10], ["other", 10]);
    expect(orderedByStart(sorted)).toBe(sorted);
    const shuffled = [sorted[1], sorted[0]];
    expect(orderedByStart(shuffled).map((row) => row.id)).toEqual(sorted.map((row) => row.id));
  });
});

describe("runNeighbors", () => {
  const neighborsOf = (rows: Row[], runIndex = 0, startSec = 0, endSec = 1e9) => {
    const run = collectRuns(rows, kindOf, startSec, endSec)[runIndex];
    const { before, after } = runNeighbors(rows, kindOf, run);
    const label = (side: Row | "break" | null) =>
      side === null ? null : side === "break" ? "break" : side.name;
    return { before: label(before), after: label(after) };
  };

  it("names what held the foreground on either side", () => {
    expect(neighborsOf(timeline(0, ["other", 600, "chat"], ["in", 600], ["other", 600, "music"])))
      .toEqual({ before: "chat", after: "music" });
  });

  it("looks past a glance to what the reader actually came from and went to", () => {
    expect(neighborsOf(timeline(
      0,
      ["other", 600, "chat"],
      ["other", 3, "files"],
      ["in", 600],
      ["other", 4, "start menu"],
      ["other", 600, "music"],
    ))).toEqual({ before: "chat", after: "music" });
  });

  it("reports idle time and long silences as a break", () => {
    expect(neighborsOf(timeline(0, ["idle", 600], ["in", 600], ["gap", 120], ["other", 600, "music"])))
      .toEqual({ before: "break", after: "break" });
    expect(neighborsOf(timeline(0, ["other", 600, "chat"], ["gap", RUN_GAP_TOLERANCE_SECONDS + 1], ["in", 600])).before)
      .toBe("break");
  });

  it("knows nothing on a side where the rows run out", () => {
    expect(neighborsOf(timeline(0, ["in", 600]))).toEqual({ before: null, after: null });
    // Trailing glances are not where the reader went: there may be more coming.
    expect(neighborsOf(timeline(0, ["in", 600], ["other", 5, "files"])).after).toBeNull();
  });

  it("names the nearest glance when a string of them is what ended the run", () => {
    const rows = timeline(
      0,
      ["in", 600],
      ["other", 12, "chat"],
      ["other", 12, "music"],
      ["other", 12, "files"],
      ["in", 600],
    );
    expect(neighborsOf(rows, 0).after).toBe("chat");
    expect(neighborsOf(rows, 1).before).toBe("files");
  });

  it("follows a run past the edges of the range it was cut by", () => {
    const rows = timeline(
      0,
      ["other", 600, "chat"],
      ["in", 600],
      ["in", 600],
      ["in", 600],
      ["other", 600, "music"],
    );
    // The range holds only the middle row; the run, and what surrounds it,
    // carries on past both of its edges.
    expect(neighborsOf(rows, 0, 1300, 1700)).toEqual({ before: "chat", after: "music" });
  });
});

describe("timeWeightedMedian", () => {
  it("answers for the time, not the count", () => {
    // Three ten-second passes and one ten-minute stretch: the plain median is
    // ten seconds, but nearly all of the time sits in the long run.
    expect(timeWeightedMedian([10, 10, 10, 600])).toBe(600);
  });

  it("returns the run that crosses the halfway point", () => {
    expect(timeWeightedMedian([60, 120, 180])).toBe(120);
    expect(timeWeightedMedian([300])).toBe(300);
  });

  it("has nothing to say about no time", () => {
    expect(timeWeightedMedian([])).toBeNull();
    expect(timeWeightedMedian([0, 0])).toBeNull();
  });
});

describe("runStats", () => {
  it("summarizes runs", () => {
    const runs = collectRuns(timeline(0, ["in", 60], ["idle", 5], ["in", 120], ["idle", 5], ["in", 180]), kindOf, 0, 1e9);
    expect(runStats(runs)).toEqual({ runs: 3, seconds: 360, typicalSeconds: 120, longestSeconds: 180 });
    expect(runStats([])).toEqual({ runs: 0, seconds: 0, typicalSeconds: null, longestSeconds: null });
  });

  it("copes with more runs than a spread could pass as arguments", () => {
    const runs = Array.from({ length: 300_000 }, (_, index) => ({
      start: index * 100,
      end: index * 100 + 10,
      seconds: index === 123_456 ? 99 : 10,
      first: index,
      last: index,
    }));
    expect(runStats(runs).longestSeconds).toBe(99);
  });
});
