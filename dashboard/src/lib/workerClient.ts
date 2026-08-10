// The machinery both analysis clients need: a bounded result cache, one
// in-flight request per key, a worker whose loss silently degrades to computing
// on the main thread, and a teardown that fails anything still waiting.
//
// Activity and Insights each held their own copy. The subtle parts — the
// `onmessageerror` fallback, and the identity check that stops a settled
// promise from evicting its own successor from `pendingByKey` — are not the
// sort of thing that gets re-derived correctly a second time.

let nextObjectId = 1;
const objectIds = new WeakMap<object, number>();

/**
 * A stable number for an object's identity, for use in a cache key.
 *
 * Analysis inputs are large arrays that are replaced wholesale rather than
 * mutated, so identity is the cheap and correct staleness test: same array,
 * same answer. Deep-hashing them per keystroke would cost more than the
 * analysis being cached.
 */
export function objectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
}

/** What a client posts for one request, with any buffers to hand over. */
export interface WorkerMessage {
  message: unknown;
  transfer?: Transferable[];
}

/** Every worker response carries the id it answers, or an error for it. */
interface WorkerResponse {
  id: number;
  error?: string;
}

export interface WorkerClientOptions<Req, Res> {
  /** Results held before the oldest is evicted. */
  maxCached: number;
  createWorker: () => Worker;
  /** Pull the payload out of a success response (`result`, `model`, …). */
  readResult: (data: WorkerResponse) => Res;
  /**
   * Build the message for one request. May be async — Insights packs large
   * ranges in chunks, yielding between them — in which case the worker is
   * re-checked afterwards, since it can be lost while packing.
   */
  buildMessage: (id: number, request: Req) => WorkerMessage | Promise<WorkerMessage>;
  /** Compute the answer synchronously on the main thread. */
  computeLocally: (request: Req) => Res;
  /** Reset any client-owned state that assumed a live worker. */
  onWorkerLost?: () => void;
  /** Reset any client-owned caches on teardown. */
  onClear?: () => void;
  /** Rejection message for work still in flight when the data is refreshed. */
  clearedMessage: string;
}

export interface WorkerClient<Req, Res> {
  analyze: (key: string, request: Req) => Promise<Res>;
  peek: (key: string) => Res | null;
  clear: () => void;
}

export function createWorkerClient<Req, Res>(
  options: WorkerClientOptions<Req, Res>,
): WorkerClient<Req, Res> {
  const {
    maxCached,
    createWorker,
    readResult,
    buildMessage,
    computeLocally,
    onWorkerLost,
    onClear,
    clearedMessage,
  } = options;

  const cache = new Map<string, Res>();
  const pendingByKey = new Map<string, Promise<Res>>();
  const pendingById = new Map<
    number,
    { key: string; request: Req; resolve: (value: Res) => void; reject: (error: Error) => void }
  >();
  let worker: Worker | null = null;
  let workerUnavailable = false;
  let nextRequestId = 1;

  function remember(key: string, value: Res): Res {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxCached) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return value;
  }

  function onMainThread(key: string, request: Req): Promise<Res> {
    // A worker load/CSP failure must not make the view unusable. Yield first so
    // the retained prior view and its loading affordance can paint.
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(remember(key, computeLocally(request)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, 0);
    });
  }

  function disableWorkerAndFallback(): void {
    workerUnavailable = true;
    worker?.terminate();
    worker = null;
    onWorkerLost?.();
    const waiting = [...pendingById.values()];
    pendingById.clear();
    for (const pending of waiting) {
      void onMainThread(pending.key, pending.request).then(pending.resolve, pending.reject);
    }
  }

  function getWorker(): Worker | null {
    if (workerUnavailable) return null;
    if (worker) return worker;
    try {
      worker = createWorker();
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const pending = pendingById.get(event.data.id);
        if (!pending) return;
        pendingById.delete(event.data.id);
        if (event.data.error !== undefined) pending.reject(new Error(event.data.error));
        else pending.resolve(remember(pending.key, readResult(event.data)));
      };
      worker.onerror = () => disableWorkerAndFallback();
      worker.onmessageerror = () => disableWorkerAndFallback();
      return worker;
    } catch {
      workerUnavailable = true;
      return null;
    }
  }

  function analyze(key: string, request: Req): Promise<Res> {
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached);
    const active = pendingByKey.get(key);
    if (active) return active;

    const initialWorker = getWorker();
    const promise = initialWorker
      ? new Promise<Res>((resolve, reject) => {
          const id = nextRequestId++;
          const fail = (error: unknown) =>
            reject(error instanceof Error ? error : new Error(String(error)));
          const post = (ready: WorkerMessage, live: Worker) => {
            pendingById.set(id, { key, request, resolve, reject });
            live.postMessage(ready.message, ready.transfer ?? []);
          };

          let built: WorkerMessage | Promise<WorkerMessage>;
          try {
            built = buildMessage(id, request);
          } catch (error) {
            fail(error);
            return;
          }

          // Post synchronously when the message was built synchronously. A
          // client that packs its request (Insights, on long ranges) yields
          // first, so its worker is re-read afterwards — it can be lost while
          // packing. A client that does not (Activity) must not be pushed onto
          // a microtask: its `workerSessionKey` bookkeeping decides whether to
          // resend the sessions, and an await between deciding and posting is
          // a window for a second request to decide the same thing.
          if (built instanceof Promise) {
            void built.then((ready) => {
              const live = getWorker();
              if (!live) {
                void onMainThread(key, request).then(resolve, reject);
                return;
              }
              post(ready, live);
            }, fail);
          } else {
            post(built, initialWorker);
          }
        })
      : onMainThread(key, request);

    // Only clear the slot this promise put there: a slower predecessor settling
    // late must not evict the newer request now holding the key.
    const tracked = promise.finally(() => {
      if (pendingByKey.get(key) === tracked) pendingByKey.delete(key);
    });
    pendingByKey.set(key, tracked);
    return tracked;
  }

  return {
    analyze,
    peek: (key) => cache.get(key) ?? null,
    clear: () => {
      const error = new Error(clearedMessage);
      for (const pending of pendingById.values()) pending.reject(error);
      cache.clear();
      pendingByKey.clear();
      pendingById.clear();
      worker?.terminate();
      worker = null;
      onClear?.();
    },
  };
}
