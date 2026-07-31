/**
 * Worker orchestration and the source-packing memo, not query semantics —
 * `activity.test.ts` owns those. Two properties matter: a worker that never
 * loads still answers, and the worker is never allowed to answer from a
 * session set that history invalidation has already superseded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityIndex,
  ActivityQuery,
  ActivityQueryResult,
  ActivitySource,
  PackedActivitySource,
} from "./activity";

const { buildActivityIndex, packActivitySource, queryActivityIndex } = vi.hoisted(() => ({
  buildActivityIndex: vi.fn(),
  packActivitySource: vi.fn(),
  queryActivityIndex: vi.fn(),
}));

vi.mock("./activity", () => ({ buildActivityIndex, packActivitySource, queryActivityIndex }));

interface PostedMessage {
  id: number;
  sessionKey: string;
  classificationKey: string;
  source?: PackedActivitySource;
  query: ActivityQuery;
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

  respond(
    response: { id: number; result: ActivityQueryResult } | { id: number; error: string },
  ): void {
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

function onlyWorker(): StubWorker {
  expect(StubWorker.instances).toHaveLength(1);
  return StubWorker.instances[0];
}

const result = (tag: string) =>
  ({ catalog: { rows: [], total: 0 }, noiseHidden: 0, windowMatches: null, tag }) as unknown as
    ActivityQueryResult;

const index = (tag: string) => ({ tag }) as unknown as ActivityIndex;

function packedSource(): PackedActivitySource {
  return {
    ids: new Float64Array(1),
    starts: new Float64Array(1),
    ends: new Float64Array(1),
    processIndices: new Uint32Array(1),
    titleIndices: new Uint32Array(1),
    domainIndices: new Int32Array(1),
    isAfk: new Uint8Array(1),
    categoryOverrideIds: new Int32Array(1),
    isCorrected: new Uint8Array(1),
    processes: ["app.exe"],
    titles: [""],
    domains: [],
    categories: [],
    rules: [],
  } as unknown as PackedActivitySource;
}

/** Source keys are array identity, so reusing one object means one key. */
function source(overrides: Partial<ActivitySource> = {}): ActivitySource {
  return {
    sessions: [],
    categories: [],
    rules: [],
    browserProcesses: [],
    aliases: {},
    ...overrides,
  };
}

function query(overrides: Partial<ActivityQuery> = {}): ActivityQuery {
  return {
    startSec: 0,
    endSec: 3_600,
    search: "",
    typeFilter: "all",
    classificationFilter: "all",
    sort: "time",
    direction: "desc",
    windowSort: "time",
    windowDirection: "desc",
    entityOffset: 0,
    entityLimit: 25,
    windowOffset: 0,
    windowLimit: 25,
    ...overrides,
  } as ActivityQuery;
}

/** Module state is global and a worker given up on is never retried, so every
 *  test needs its own module instance. */
async function loadClient() {
  return await import("./activityClient");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  StubWorker.instances = [];
  StubWorker.blockConstruction = false;
  packActivitySource.mockImplementation(() => packedSource());
  vi.stubGlobal("Worker", StubWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker failure fallback", () => {
  it("answers an in-flight query on the main thread when the worker errors", async () => {
    const fallback = result("fallback");
    buildActivityIndex.mockReturnValue(index("built"));
    queryActivityIndex.mockReturnValue(fallback);
    const { analyzeActivity } = await loadClient();
    const input = source();
    const request = query();

    const promise = analyzeActivity(input, request);
    const worker = onlyWorker();
    expect(worker.posted).toHaveLength(1);
    worker.onerror?.();

    await expect(promise).resolves.toBe(fallback);
    expect(buildActivityIndex).toHaveBeenCalledWith(input);
    expect(queryActivityIndex).toHaveBeenCalledWith(index("built"), request);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("treats an undeliverable message the same as a load failure", async () => {
    const fallback = result("fallback");
    buildActivityIndex.mockReturnValue(index("built"));
    queryActivityIndex.mockReturnValue(fallback);
    const { analyzeActivity } = await loadClient();

    const promise = analyzeActivity(source(), query());
    onlyWorker().onmessageerror?.();

    await expect(promise).resolves.toBe(fallback);
  });

  it("falls back without posting when the worker cannot be constructed at all", async () => {
    StubWorker.blockConstruction = true;
    const fallback = result("fallback");
    buildActivityIndex.mockReturnValue(index("built"));
    queryActivityIndex.mockReturnValue(fallback);
    const { analyzeActivity } = await loadClient();

    await expect(analyzeActivity(source(), query())).resolves.toBe(fallback);
    expect(StubWorker.instances).toHaveLength(0);
  });

  it("surfaces a main-thread index failure instead of hanging", async () => {
    StubWorker.blockConstruction = true;
    buildActivityIndex.mockImplementation(() => {
      throw new Error("index build failed");
    });
    const { analyzeActivity } = await loadClient();

    await expect(analyzeActivity(source(), query())).rejects.toThrow("index build failed");
  });
});

describe("main-thread index reuse", () => {
  beforeEach(() => {
    StubWorker.blockConstruction = true;
    buildActivityIndex.mockImplementation((input: ActivitySource) => index(String(input.sessions.length)));
    queryActivityIndex.mockImplementation(() => result("answer"));
  });

  it("builds the fallback index once and reuses it across queries of one source", async () => {
    const { analyzeActivity } = await loadClient();
    const input = source();

    await analyzeActivity(input, query());
    await analyzeActivity(input, query({ entityOffset: 25 }));

    expect(buildActivityIndex).toHaveBeenCalledOnce();
    expect(queryActivityIndex).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the fallback index when the session set changes", async () => {
    const { analyzeActivity } = await loadClient();

    await analyzeActivity(source(), query());
    await analyzeActivity(source({ sessions: [{ id: 1 }] as ActivitySource["sessions"] }), query());

    expect(buildActivityIndex).toHaveBeenCalledTimes(2);
  });
});

describe("source packing memo", () => {
  it("packs the session columns once and omits them from later queries", async () => {
    const { analyzeActivity } = await loadClient();
    const input = source();

    void analyzeActivity(input, query());
    const worker = onlyWorker();
    worker.respond({ id: worker.posted[0].id, result: result("first") });
    void analyzeActivity(input, query({ entityOffset: 25 }));

    expect(packActivitySource).toHaveBeenCalledOnce();
    expect(worker.posted[0].source).toBeDefined();
    expect(worker.posted[1].source).toBeUndefined();
    expect(worker.transfers[1]).toEqual([]);
  });

  it("repacks when the session set changes so the worker never answers from stale rows", async () => {
    const { analyzeActivity } = await loadClient();

    void analyzeActivity(source(), query());
    void analyzeActivity(source({ sessions: [{ id: 1 }] as ActivitySource["sessions"] }), query());

    const worker = onlyWorker();
    expect(packActivitySource).toHaveBeenCalledTimes(2);
    expect(worker.posted[1].source).toBeDefined();
    expect(worker.posted[0].sessionKey).not.toBe(worker.posted[1].sessionKey);
  });

  it("transfers the packed column buffers rather than cloning them", async () => {
    const columns = packedSource();
    packActivitySource.mockReturnValue(columns);
    const { analyzeActivity } = await loadClient();

    void analyzeActivity(source(), query());

    expect(onlyWorker().transfers[0]).toEqual([
      columns.ids.buffer,
      columns.starts.buffer,
      columns.ends.buffer,
      columns.processIndices.buffer,
      columns.titleIndices.buffer,
      columns.domainIndices.buffer,
      columns.isAfk.buffer,
      columns.categoryOverrideIds.buffer,
      columns.isCorrected.buffer,
    ]);
  });

  it("rejects the caller when packing itself fails", async () => {
    packActivitySource.mockImplementation(() => {
      throw new Error("packing overflowed");
    });
    const { analyzeActivity } = await loadClient();

    await expect(analyzeActivity(source(), query())).rejects.toThrow("packing overflowed");
    expect(onlyWorker().posted).toHaveLength(0);
  });

  it("carries a changed classification without repacking the sessions", async () => {
    const { analyzeActivity } = await loadClient();
    const sessions: ActivitySource["sessions"] = [];

    void analyzeActivity(source({ sessions }), query());
    void analyzeActivity(source({ sessions, browserProcesses: ["chrome.exe"] }), query());

    const worker = onlyWorker();
    expect(packActivitySource).toHaveBeenCalledOnce();
    expect(worker.posted[0].sessionKey).toBe(worker.posted[1].sessionKey);
    expect(worker.posted[0].classificationKey).not.toBe(worker.posted[1].classificationKey);
  });
});

describe("in-flight and cached reuse", () => {
  it("collapses concurrent identical queries into one worker round trip", async () => {
    const { analyzeActivity } = await loadClient();
    const input = source();
    const request = query();

    const first = analyzeActivity(input, request);
    const second = analyzeActivity(input, request);
    expect(second).toBe(first);

    const worker = onlyWorker();
    expect(worker.posted).toHaveLength(1);
    const answer = result("worker");
    worker.respond({ id: worker.posted[0].id, result: answer });

    await expect(first).resolves.toBe(answer);
  });

  it("serves a completed result from cache without asking the worker again", async () => {
    const { analyzeActivity, activityRequestKey, peekActivityResult } = await loadClient();
    const input = source();
    const request = query();

    const promise = analyzeActivity(input, request);
    const worker = onlyWorker();
    const answer = result("worker");
    worker.respond({ id: worker.posted[0].id, result: answer });
    await promise;

    expect(peekActivityResult(activityRequestKey(input, request))).toBe(answer);
    await expect(analyzeActivity(input, request)).resolves.toBe(answer);
    expect(worker.posted).toHaveLength(1);
  });

  it("rejects the caller when the worker reports a failure", async () => {
    const { analyzeActivity } = await loadClient();

    const promise = analyzeActivity(source(), query());
    const worker = onlyWorker();
    worker.respond({ id: worker.posted[0].id, error: "query failed" });

    await expect(promise).rejects.toThrow("query failed");
  });

  it("ignores a response whose request is no longer pending", async () => {
    const { analyzeActivity } = await loadClient();

    const promise = analyzeActivity(source(), query());
    const worker = onlyWorker();
    const answer = result("worker");
    worker.respond({ id: 9_999, result: result("stray") });
    worker.respond({ id: worker.posted[0].id, result: answer });

    await expect(promise).resolves.toBe(answer);
  });

  it("keeps the twelve most recent results and drops the oldest", async () => {
    const { analyzeActivity, activityRequestKey, peekActivityResult } = await loadClient();
    const input = source();
    const requests = Array.from({ length: 13 }, (_, offset) => query({ entityOffset: offset }));

    for (const [position, request] of requests.entries()) {
      const promise = analyzeActivity(input, request);
      const worker = onlyWorker();
      worker.respond({ id: worker.posted[position].id, result: result(`result-${position}`) });
      await promise;
    }

    expect(peekActivityResult(activityRequestKey(input, requests[0]))).toBeNull();
    for (const request of requests.slice(1)) {
      expect(peekActivityResult(activityRequestKey(input, request))).not.toBeNull();
    }
  });
});

describe("clearActivityAnalysis", () => {
  it("rejects work still in flight rather than leaving it pending forever", async () => {
    const { analyzeActivity, clearActivityAnalysis } = await loadClient();

    const promise = analyzeActivity(source(), query());
    const worker = onlyWorker();
    clearActivityAnalysis();

    await expect(promise).rejects.toThrow("Activity data was refreshed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("forces the next query to repack, so no answer can come from erased history", async () => {
    const { analyzeActivity, clearActivityAnalysis, activityRequestKey, peekActivityResult } =
      await loadClient();
    const input = source();
    const request = query();

    const promise = analyzeActivity(input, request);
    const worker = onlyWorker();
    worker.respond({ id: worker.posted[0].id, result: result("before") });
    await promise;
    clearActivityAnalysis();

    expect(peekActivityResult(activityRequestKey(input, request))).toBeNull();
    void analyzeActivity(input, request);

    expect(StubWorker.instances).toHaveLength(2);
    expect(packActivitySource).toHaveBeenCalledTimes(2);
    expect(StubWorker.instances[1].posted[0].source).toBeDefined();
  });

  it("discards the main-thread index too", async () => {
    StubWorker.blockConstruction = true;
    buildActivityIndex.mockReturnValue(index("built"));
    queryActivityIndex.mockReturnValue(result("answer"));
    const { analyzeActivity, clearActivityAnalysis } = await loadClient();
    const input = source();

    await analyzeActivity(input, query());
    clearActivityAnalysis();
    await analyzeActivity(input, query({ entityOffset: 25 }));

    expect(buildActivityIndex).toHaveBeenCalledTimes(2);
  });
});
