/**
 * Worker orchestration, not model arithmetic — `insights.test.ts` owns the
 * numbers. What matters here is that a worker which never loads (the packaged
 * app runs under a CSP the dev server does not) still produces a model instead
 * of leaving Insights spinning forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InsightsModel, InsightsRequest, PackedInsightsRequest } from "./insights";

const { buildInsightsModel, packInsightsRequestInChunks } = vi.hoisted(() => ({
  buildInsightsModel: vi.fn(),
  packInsightsRequestInChunks: vi.fn(),
}));

vi.mock("./insights", () => ({ buildInsightsModel, packInsightsRequestInChunks }));

interface PostedMessage {
  id: number;
  request?: InsightsRequest;
  packed?: PackedInsightsRequest;
}

class StubWorker {
  static instances: StubWorker[] = [];
  static blockConstruction = false;

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: PostedMessage[] = [];
  readonly transfers: unknown[][] = [];
  readonly terminate = vi.fn();

  constructor() {
    if (StubWorker.blockConstruction) throw new Error("worker blocked by policy");
    StubWorker.instances.push(this);
  }

  postMessage(message: PostedMessage, transfer: unknown[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  respond(response: { id: number; model: InsightsModel } | { id: number; error: string }): void {
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

function onlyWorker(): StubWorker {
  expect(StubWorker.instances).toHaveLength(1);
  return StubWorker.instances[0];
}

const model = (tag: string) => ({ rangeDays: 1, labelMode: "date", tag }) as unknown as InsightsModel;

function packed(): PackedInsightsRequest {
  return {
    request: {} as Omit<InsightsRequest, "sessions">,
    starts: new Float64Array(1),
    ends: new Float64Array(1),
    processIndices: new Uint32Array(1),
    domainIndices: new Uint32Array(1),
    categoryIndices: new Int32Array(1),
    isAfk: new Uint8Array(1),
    processes: ["app.exe"],
    domains: [],
  };
}

/** Keys are built from array identity, so a request reused across calls is the
 *  same key and a freshly built one never is. Tests pick deliberately. */
function request(overrides: Partial<InsightsRequest> = {}): InsightsRequest {
  return {
    sessions: [],
    range: { start: new Date(2026, 6, 1), end: new Date(2026, 6, 8) },
    categories: [],
    rules: [],
    browserProcesses: [],
    weekStart: "Monday",
    weeklyGoalHours: 40,
    minAppSecondsPerDay: 60,
    aliases: {},
    focusChainMaxGapSeconds: 300,
    dayStartHour: 0,
    dayEndHour: 24,
    labelMode: "date",
    ...overrides,
  };
}

/** Module state is global and `clearInsightsModels` deliberately does not
 *  re-enable a worker it gave up on, so every test needs its own instance. */
async function loadClient() {
  return await import("./insightsClient");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  StubWorker.instances = [];
  StubWorker.blockConstruction = false;
  vi.stubGlobal("Worker", StubWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker failure fallback", () => {
  it("finishes an in-flight request on the main thread when the worker errors", async () => {
    const fallback = model("fallback");
    buildInsightsModel.mockReturnValue(fallback);
    const { analyzeInsights } = await loadClient();
    const input = request();

    const promise = analyzeInsights(input);
    const worker = onlyWorker();
    expect(worker.posted).toHaveLength(1);
    worker.onerror?.();

    await expect(promise).resolves.toBe(fallback);
    expect(buildInsightsModel).toHaveBeenCalledWith(input);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("treats an undeliverable message the same as a load failure", async () => {
    const fallback = model("fallback");
    buildInsightsModel.mockReturnValue(fallback);
    const { analyzeInsights } = await loadClient();

    const promise = analyzeInsights(request());
    onlyWorker().onmessageerror?.();

    await expect(promise).resolves.toBe(fallback);
  });

  it("stops rebuilding a worker that already failed once", async () => {
    buildInsightsModel.mockImplementation(() => model("fallback"));
    const { analyzeInsights } = await loadClient();

    const first = analyzeInsights(request());
    onlyWorker().onerror?.();
    await first;
    await expect(analyzeInsights(request())).resolves.toMatchObject({ tag: "fallback" });

    expect(StubWorker.instances).toHaveLength(1);
    expect(buildInsightsModel).toHaveBeenCalledTimes(2);
  });

  it("falls back without posting when the worker cannot be constructed at all", async () => {
    StubWorker.blockConstruction = true;
    const fallback = model("fallback");
    buildInsightsModel.mockReturnValue(fallback);
    const { analyzeInsights } = await loadClient();

    await expect(analyzeInsights(request())).resolves.toBe(fallback);
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("surfaces a main-thread build failure instead of hanging", async () => {
    StubWorker.blockConstruction = true;
    buildInsightsModel.mockImplementation(() => {
      throw new Error("model build failed");
    });
    const { analyzeInsights } = await loadClient();

    await expect(analyzeInsights(request())).rejects.toThrow("model build failed");
  });
});

describe("long-range packed transfer", () => {
  const longRange = { start: new Date(2026, 5, 1), end: new Date(2026, 6, 15) };

  it("transfers the packed column buffers rather than cloning them", async () => {
    const columns = packed();
    packInsightsRequestInChunks.mockResolvedValue(columns);
    const { analyzeInsights } = await loadClient();

    const promise = analyzeInsights(request({ range: longRange }));
    await vi.waitFor(() => expect(onlyWorker().posted).toHaveLength(1));
    const worker = onlyWorker();

    expect(worker.posted[0].packed).toBe(columns);
    expect(worker.transfers[0]).toEqual([
      columns.starts.buffer,
      columns.ends.buffer,
      columns.processIndices.buffer,
      columns.domainIndices.buffer,
      columns.categoryIndices.buffer,
      columns.isAfk.buffer,
    ]);

    const built = model("worker");
    worker.respond({ id: worker.posted[0].id, model: built });
    await expect(promise).resolves.toBe(built);
  });

  it("rejects the caller when packing itself fails", async () => {
    packInsightsRequestInChunks.mockRejectedValue(new Error("packing overflowed"));
    const { analyzeInsights } = await loadClient();

    await expect(analyzeInsights(request({ range: longRange }))).rejects.toThrow(
      "packing overflowed",
    );
    expect(onlyWorker().posted).toHaveLength(0);
  });

  it("recovers when the worker dies while its payload is still being packed", async () => {
    let releasePacking: () => void = () => {};
    packInsightsRequestInChunks.mockReturnValue(
      new Promise<PackedInsightsRequest>((resolve) => {
        releasePacking = () => resolve(packed());
      }),
    );
    const fallback = model("fallback");
    buildInsightsModel.mockReturnValue(fallback);
    const { analyzeInsights } = await loadClient();

    const promise = analyzeInsights(request({ range: longRange }));
    const worker = onlyWorker();
    worker.onerror?.();
    releasePacking();

    await expect(promise).resolves.toBe(fallback);
    expect(worker.posted).toHaveLength(0);
  });
});

describe("in-flight and cached reuse", () => {
  it("collapses concurrent identical requests into one worker round trip", async () => {
    const { analyzeInsights } = await loadClient();
    const input = request();

    const first = analyzeInsights(input);
    const second = analyzeInsights(input);
    expect(second).toBe(first);

    const worker = onlyWorker();
    expect(worker.posted).toHaveLength(1);
    const built = model("worker");
    worker.respond({ id: worker.posted[0].id, model: built });

    await expect(first).resolves.toBe(built);
    await expect(second).resolves.toBe(built);
  });

  it("serves a completed model from cache without asking the worker again", async () => {
    const { analyzeInsights, insightsRequestKey, peekInsightsModel } = await loadClient();
    const input = request();

    const promise = analyzeInsights(input);
    const worker = onlyWorker();
    const built = model("worker");
    worker.respond({ id: worker.posted[0].id, model: built });
    await promise;

    expect(peekInsightsModel(insightsRequestKey(input))).toBe(built);
    await expect(analyzeInsights(input)).resolves.toBe(built);
    expect(worker.posted).toHaveLength(1);
  });

  it("releases the in-flight slot so a later identical request can be reissued", async () => {
    const { analyzeInsights } = await loadClient();
    const input = request();

    const promise = analyzeInsights(input);
    const worker = onlyWorker();
    worker.respond({ id: worker.posted[0].id, error: "worker gave up" });
    await expect(promise).rejects.toThrow("worker gave up");

    void analyzeInsights(input);
    expect(worker.posted).toHaveLength(2);
  });

  it("warms the cache so the view can later render without a round trip", async () => {
    const { analyzeInsights, warmInsightsModel, insightsRequestKey, peekInsightsModel } =
      await loadClient();
    const input = request();

    const warming = warmInsightsModel(input);
    const worker = onlyWorker();
    const built = model("warmed");
    worker.respond({ id: worker.posted[0].id, model: built });
    await warming;

    expect(peekInsightsModel(insightsRequestKey(input))).toBe(built);
    await expect(analyzeInsights(input)).resolves.toBe(built);
    expect(worker.posted).toHaveLength(1);
  });

  it("rejects the caller when the worker reports a failure", async () => {
    const { analyzeInsights } = await loadClient();

    const promise = analyzeInsights(request());
    const worker = onlyWorker();
    worker.respond({ id: worker.posted[0].id, error: "packed columns mismatched" });

    await expect(promise).rejects.toThrow("packed columns mismatched");
  });

  it("ignores a response whose request is no longer pending", async () => {
    const { analyzeInsights } = await loadClient();

    const promise = analyzeInsights(request());
    const worker = onlyWorker();
    const built = model("worker");
    worker.respond({ id: 9_999, model: model("stray") });
    worker.respond({ id: worker.posted[0].id, model: built });

    await expect(promise).resolves.toBe(built);
  });
});

describe("model cache bounds", () => {
  it("keeps the eight most recent models and drops the oldest", async () => {
    const { analyzeInsights, insightsRequestKey, peekInsightsModel } = await loadClient();
    const sessions: InsightsRequest["sessions"] = [];
    const inputs = Array.from({ length: 9 }, (_, index) =>
      request({ sessions, weeklyGoalHours: index }),
    );

    for (const [index, input] of inputs.entries()) {
      const promise = analyzeInsights(input);
      const worker = onlyWorker();
      worker.respond({ id: worker.posted[index].id, model: model(`model-${index}`) });
      await promise;
    }

    expect(peekInsightsModel(insightsRequestKey(inputs[0]))).toBeNull();
    for (const input of inputs.slice(1)) {
      expect(peekInsightsModel(insightsRequestKey(input))).not.toBeNull();
    }
  });
});

describe("clearInsightsModels", () => {
  it("rejects work still in flight rather than leaving it pending forever", async () => {
    const { analyzeInsights, clearInsightsModels } = await loadClient();

    const promise = analyzeInsights(request());
    const worker = onlyWorker();
    clearInsightsModels();

    await expect(promise).rejects.toThrow("Insights data was refreshed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("drops cached models so the next request is recomputed", async () => {
    const { analyzeInsights, clearInsightsModels, insightsRequestKey, peekInsightsModel } =
      await loadClient();
    const input = request();

    const promise = analyzeInsights(input);
    const worker = onlyWorker();
    worker.respond({ id: worker.posted[0].id, model: model("first") });
    await promise;
    clearInsightsModels();

    expect(peekInsightsModel(insightsRequestKey(input))).toBeNull();
    void analyzeInsights(input);
    expect(StubWorker.instances).toHaveLength(2);
    expect(StubWorker.instances[1].posted).toHaveLength(1);
  });

});
