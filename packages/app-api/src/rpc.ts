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

export function expose(api: object, port: PortLike): { emit(type: string, payload: unknown): void } {
  port.addEventListener('message', (e) => {
    const msg = e.data;
    if (!isObj(msg) || msg.k !== 'call') return;
    const { id, m, a } = msg as unknown as CallMsg;
    const reply = (r: ResMsg) => port.postMessage(r);
    const fn = (api as Record<string, unknown>)[m];
    if (typeof m !== 'string' || m in Object.prototype || typeof fn !== 'function') {
      reply({ k: 'res', id, ok: false, e: { name: 'RpcError', message: `Unknown method: ${String(m)}` } });
      return;
    }
    Promise.resolve()
      .then(() => (fn as (...args: unknown[]) => unknown).apply(api, Array.isArray(a) ? a : []))
      .then(
        (v) => reply({ k: 'res', id, ok: true, v }),
        (err) => reply({ k: 'res', id, ok: false, e: toRpcError(err) }),
      );
  });
  port.start?.();
  return {
    emit(type, payload) {
      port.postMessage({ k: 'evt', t: type, p: payload } satisfies EvtMsg);
    },
  };
}

export function wrap<T>(port: PortLike): { api: Remote<T>; on(type: string, fn: (payload: unknown) => void): () => void } {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  port.addEventListener('message', (e) => {
    const msg = e.data;
    if (!isObj(msg)) return;
    if (msg.k === 'res') {
      const res = msg as unknown as ResMsg;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res.v);
      else p.reject(fromRpcError(res.e));
    } else if (msg.k === 'evt') {
      const evt = msg as unknown as EvtMsg;
      for (const fn of listeners.get(evt.t) ?? []) fn(evt.p);
    }
  });
  port.start?.();

  const api = new Proxy({}, {
    get(_t, prop) {
      // Never look like a thenable, or `await wrap(...).api` would hang.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...a: unknown[]) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        port.postMessage({ k: 'call', id, m: prop, a } satisfies CallMsg);
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
  };
}
