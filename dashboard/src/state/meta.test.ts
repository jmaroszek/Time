import { describe, expect, it } from "vitest";

import { createMetaRefreshGeneration } from "./meta";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("metadata refresh generations", () => {
  it("ignores an older deferred result after a newer request begins", async () => {
    const gate = createMetaRefreshGeneration();
    const first = deferred<string>();
    const second = deferred<string>();
    const committed: string[] = [];

    const refresh = async (request: Promise<string>) => {
      const generation = gate.begin();
      const value = await request;
      if (gate.isCurrent(generation)) committed.push(value);
    };

    const firstRequest = refresh(first.promise);
    const secondRequest = refresh(second.promise);
    first.resolve("old");
    await firstRequest;
    expect(committed).toEqual([]);

    second.resolve("new");
    await secondRequest;
    expect(committed).toEqual(["new"]);
  });

  it("allows only the newest request to commit an error too", async () => {
    const gate = createMetaRefreshGeneration();
    const first = deferred<never>();
    const second = deferred<never>();
    const committed: string[] = [];

    const refresh = async (request: Promise<never>) => {
      const generation = gate.begin();
      try {
        await request;
      } catch (error) {
        if (gate.isCurrent(generation)) committed.push(String(error));
      }
    };

    const firstRequest = refresh(first.promise);
    const secondRequest = refresh(second.promise);
    first.reject("old error");
    await firstRequest;
    expect(committed).toEqual([]);

    second.reject("new error");
    await secondRequest;
    expect(committed).toEqual(["new error"]);
  });
});
