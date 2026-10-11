import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerClient, type WorkerMessage } from "./workerClient";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(buildMessage = (id: number): WorkerMessage | Promise<WorkerMessage> => ({ message: { id } })) {
  const workers: Worker[] = [];
  const postMessage = vi.fn();
  const computeLocally = vi.fn((value: string) => value);
  const createWorker = vi.fn(() => {
    const worker = { postMessage, terminate: vi.fn() } as unknown as Worker;
    workers.push(worker);
    return worker;
  });
  const client = createWorkerClient<string, string>({
    maxCached: 2,
    createWorker,
    buildMessage,
    computeLocally,
    readResult: (data) => (data as typeof data & { result: string }).result,
    clearedMessage: "Data refreshed",
  });
  return { client, workers, postMessage, computeLocally, createWorker };
}

afterEach(() => { vi.useRealTimers(); });

describe("worker request cancellation", () => {
  it("rejects immediately during packing and cannot post or cache the old request later", async () => {
    const packed = deferred<WorkerMessage>();
    const f = fixture(() => packed.promise);
    const old = f.client.analyze("same", "old");
    const rejected = expect(old).rejects.toThrow("Data refreshed");
    f.client.clear();
    await rejected;

    packed.resolve({ message: { id: 1 } });
    await Promise.resolve();
    expect(f.postMessage).not.toHaveBeenCalled();
    expect(f.createWorker).toHaveBeenCalledOnce();
    expect(f.client.peek("same")).toBeNull();
  });

  it.each(["construction", "worker error"])("cancels queued local work after %s failure", async (failure) => {
    vi.useFakeTimers();
    const f = fixture();
    if (failure === "construction") f.createWorker.mockImplementation(() => { throw Error("blocked"); });
    const old = f.client.analyze("same", "old");
    const rejected = expect(old).rejects.toThrow("Data refreshed");
    if (failure === "worker error") f.workers[0].onerror?.({} as ErrorEvent);
    f.client.clear();
    await rejected;
    await vi.runAllTimersAsync();
    expect(f.computeLocally).not.toHaveBeenCalled();
    expect(f.client.peek("same")).toBeNull();
  });

  it("keeps the replacement request when its cancelled predecessor settles", async () => {
    const oldPack = deferred<WorkerMessage>();
    const f = fixture((id) => id === 1 ? oldPack.promise : { message: { id } });
    const old = f.client.analyze("same", "old");
    const rejected = expect(old).rejects.toThrow("Data refreshed");
    f.client.clear();
    const fresh = f.client.analyze("same", "fresh");
    await rejected;
    oldPack.resolve({ message: { id: 1 } });
    await Promise.resolve();
    expect(f.client.analyze("same", "fresh")).toBe(fresh);
    // A queued error from the terminated worker cannot disable its successor.
    f.workers[0].onerror?.({} as ErrorEvent);
    f.workers[1].onmessage?.({ data: { id: 2, result: "fresh" } } as MessageEvent);
    await expect(fresh).resolves.toBe("fresh");
    expect(f.client.peek("same")).toBe("fresh");
    expect(f.postMessage).toHaveBeenCalledOnce();
  });

  it("settles a failed asynchronous post through the local fallback", async () => {
    const packed = deferred<WorkerMessage>();
    const f = fixture(() => packed.promise);
    f.postMessage.mockImplementation(() => { throw Error("cannot clone"); });
    const result = f.client.analyze("key", "answer");
    packed.resolve({ message: { id: 1 } });
    await expect(result).resolves.toBe("answer");
    expect(f.computeLocally).toHaveBeenCalledOnce();
  });
});
