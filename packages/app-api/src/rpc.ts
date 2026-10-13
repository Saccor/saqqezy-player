export interface PortLike {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  start?(): void;
}

export type Remote<T> = {
  [K in keyof T as T[K] extends (...a: any[]) => any ? K : never]:
    T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};

export interface RpcError { name: string; message: string; status?: number }

type CallMsg = { k: 'call'; id: number; m: string; a: unknown[] };
type ResMsg = { k: 'res'; id: number; ok: true; v: unknown } | { k: 'res'; id: number; ok: false; e: RpcError };
type EvtMsg = { k: 'evt'; t: string; p: unknown };

/** Serialises any thrown value; only name, message and status cross the port. */
export function toRpcError(err: unknown): RpcError {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; status?: unknown };
    const out: RpcError = {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : 'Unknown error',
    };
    if (typeof e.status === 'number') out.status = e.status;
    return out;
  }
  return { name: 'Error', message: String(err) };
}

function fromRpcError(e: RpcError): Error & { status?: number } {
  const err: Error & { status?: number } = new Error(e.message);
  err.name = e.name;
  if (e.status !== undefined) err.status = e.status;
  return err;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Serves `api` over `port`. When `methods` is given, only those names are callable; anything else
 * (including private helpers that exist at runtime) rejects with `RpcError`.
 */
export function expose(
  api: object,
  port: PortLike,
  methods?: readonly string[],
): { emit(type: string, payload: unknown): void } {
  const allowed = methods ? new Set(methods) : undefined;
  port.addEventListener('message', (e) => {
    const msg = e.data;
    if (!isObj(msg) || msg.k !== 'call') return;
    const { id, m, a } = msg as unknown as CallMsg;
    const reply = (r: ResMsg) => {
      try {
        port.postMessage(r);
      } catch {
        // Typically a DataCloneError: the result cannot cross the port. Tell the caller instead of hanging.
        try {
          port.postMessage({ k: 'res', id, ok: false, e: { name: 'RpcError', message: 'Result could not be sent' } } satisfies ResMsg);
        } catch {
          // The port itself is gone; nothing left to tell.
        }
      }
    };
    const fn = typeof m === 'string' ? (api as Record<string, unknown>)[m] : undefined;
    if (typeof m !== 'string' || m in Object.prototype || typeof fn !== 'function' || (allowed && !allowed.has(m))) {
      reply({ k: 'res', id, ok: false, e: { name: 'RpcError', message: `Unknown method: ${String(m)}` } });
      return;
    }
    Promise.resolve()
      .then(() => (fn as (...args: unknown[]) => unknown).apply(api, Array.isArray(a) ? a : []))
      .then((v) => reply({ k: 'res', id, ok: true, v }))
      .catch((err: unknown) => reply({ k: 'res', id, ok: false, e: toRpcError(err) }));
  });
  port.start?.();
  return {
    emit(type, payload) {
      port.postMessage({ k: 'evt', t: type, p: payload } satisfies EvtMsg);
    },
  };
}

export function wrap<T>(port: PortLike): {
  api: Remote<T>;
  on(type: string, fn: (payload: unknown) => void): () => void;
  /** Rejects every pending and future call with `RpcError('Worker terminated')`. */
  dispose(): void;
} {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const terminated = () => fromRpcError({ name: 'RpcError', message: 'Worker terminated' });

  port.addEventListener('message', (e) => {
    const msg = e.data;
    if (disposed || !isObj(msg)) return;
    if (msg.k === 'res') {
      const res = msg as unknown as ResMsg;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res.v);
      else p.reject(fromRpcError(res.e));
    } else if (msg.k === 'evt') {
      const evt = msg as unknown as EvtMsg;
      for (const fn of [...(listeners.get(evt.t) ?? [])]) {
        try {
          fn(evt.p);
        } catch {
          // One faulty subscriber must not starve the others.
        }
      }
    }
  });
  port.start?.();

  const api = new Proxy({}, {
    get(_t, prop) {
      // Never look like a thenable, or `await wrap(...).api` would hang.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...a: unknown[]) => new Promise((resolve, reject) => {
        if (disposed) {
          reject(terminated());
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          port.postMessage({ k: 'call', id, m: prop, a } satisfies CallMsg);
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
  }) as Remote<T>;

  return {
    api,
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => { set!.delete(fn); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const all = [...pending.values()];
      pending.clear();
      listeners.clear();
      for (const p of all) p.reject(terminated());
    },
  };
}
