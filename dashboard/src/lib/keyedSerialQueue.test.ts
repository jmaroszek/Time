import { describe, expect, it } from "vitest";

import { KeyedSerialQueue } from "./keyedSerialQueue";

describe("KeyedSerialQueue", () => {
  it("orders work for one setting without blocking another", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("palette", async () => {
      events.push("palette-1-start");
      await firstGate;
      events.push("palette-1-end");
    });
    const second = queue.run("palette", async () => {
      events.push("palette-2");
    });
    const other = queue.run("heartbeat", async () => {
      events.push("heartbeat");
    });

    await other;
    expect(events).toEqual(["palette-1-start", "heartbeat"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "palette-1-start",
      "heartbeat",
      "palette-1-end",
      "palette-2",
    ]);
  });

  it("continues with the next value after a failed write", async () => {
    const queue = new KeyedSerialQueue();
    const failed = queue.run("week_start", async () => {
      throw new Error("write failed");
    });
    const recovered = queue.run("week_start", async () => "Monday");

    await expect(failed).rejects.toThrow("write failed");
    await expect(recovered).resolves.toBe("Monday");
  });
});
