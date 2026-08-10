import { useEffect, useState } from "react";

/**
 * The shared body of the analysis hooks: hand a request to a worker client,
 * hold the last completed result while a new one is in flight, and ignore a
 * reply whose request has already been superseded.
 *
 * Activity and Insights each had their own copy of this. The cancellation guard
 * and the cache peek are subtle enough that a fix to one copy was unlikely to be
 * re-derived correctly in the other — and by the time this was extracted the two
 * had already drifted, in a clause that happened not to change the answer.
 */
export interface WorkerModelData<Res> {
  /** Current result when ready, otherwise the last completed one. */
  result: Res | null;
  current: boolean;
  refreshing: boolean;
  error: string | null;
}

/**
 * How a particular worker client is addressed. Pass one stable object per hook
 * — a module-level constant — rather than building it per render.
 */
export interface WorkerModelOps<Req, Res> {
  /** Cache identity of a request. Equal keys must mean equal results. */
  key: (request: Req) => string;
  /** Synchronous cache hit, if the client already holds this key. */
  peek: (key: string) => Res | null;
  analyze: (request: Req) => Promise<Res>;
}

interface State<Res> {
  key: string | null;
  result: Res | null;
  error: string | null;
}

export function useWorkerModel<Req, Res>(
  request: Req | null,
  ops: WorkerModelOps<Req, Res>,
): WorkerModelData<Res> {
  const key = request ? ops.key(request) : null;
  const cached = key ? ops.peek(key) : null;
  const [state, setState] = useState<State<Res>>({ key: null, result: null, error: null });

  useEffect(() => {
    if (!request || !key) return;
    let cancelled = false;
    if (cached) {
      setState({ key, result: cached, error: null });
      return;
    }
    setState((prior) => ({ ...prior, error: null }));
    void ops.analyze(request).then(
      (result) => {
        if (!cancelled) setState({ key, result, error: null });
      },
      (error) => {
        if (!cancelled) setState((prior) => ({ ...prior, key, error: String(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, key, cached, ops]);

  if (cached) return { result: cached, current: true, refreshing: false, error: null };
  const current = key !== null && state.key === key && state.error === null;
  return {
    result: state.result,
    current,
    // A null request forces a null key, which forces `current` false, so the
    // no-request case needs no clause of its own.
    refreshing: !current,
    error: key !== null && state.key === key ? state.error : null,
  };
}
