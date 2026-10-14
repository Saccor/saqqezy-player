import type { LayoutOp } from '@iptv/core';
import { RequestError } from '../connection/pending.ts';
import type { CompanionClient } from '../connection/client.ts';
import { chunkOps } from '../logic/batches.ts';
import { COPY, resultErrorCopy } from '../logic/copy.ts';
import {
  clearProgress, currentClient, markOpsSent, optimistic, publishLayout, setWork, showNotice, store, type WorkOp,
} from './store.ts';

/** "Loading channels… 1,234" from the TV's progress messages. */
export function progressText(p: { phase: 'playlist' | 'epg'; count: number }): string {
  const n = p.count.toLocaleString('en-US');
  return p.phase === 'playlist' ? `Loading channels… ${n}` : `Loading TV guide… ${n} programmes`;
}

type Request = Parameters<CompanionClient['request']>[0];

const OPS: Partial<Record<Request['t'], WorkOp>> = {
  addSource: 'add', updateSource: 'update', deleteSource: 'delete', setActiveSource: 'setActive', refresh: 'refresh',
};

export interface RunOptions {
  /** The source this request works on ('add' for a new one): it is marked as working until the result. */
  key?: string;
  /** The TV gave no sign of life for 60 s; the request keeps going (show COPY.stillWorking). */
  onStall?: () => void;
  /** False once the UI that started the request is gone: a late failure then shows as a notice. */
  attached?: () => boolean;
}

/**
 * Runs one request and turns any failure into copy (undefined on success). Then refreshes the state.
 * A stalled source request is not a failure: if it is given up later, the state shows what happened.
 */
export async function runRequest(msg: Request, opts: RunOptions = {}): Promise<string | undefined> {
  const c = currentClient();
  if (!c) return COPY.genericError;
  const { key } = opts;
  const op = OPS[msg.t];
  let stalled = false;
  if (key !== undefined && op) setWork(key, { op, stalled: false });
  let err: string | undefined;
  try {
    const r = await c.request(msg, () => {
      stalled = true;
      if (key !== undefined && op && store.working[key]) setWork(key, { op, stalled: true });
      opts.onStall?.();
    });
    err = r.ok ? undefined : resultErrorCopy(r.error);
  } catch (e) {
    if (e instanceof RequestError && e.reason === 'timeout') err = stalled ? undefined : COPY.timeout;
    else if (e instanceof Error && e.name === 'QueueFullError') err = COPY.busy;
    else err = COPY.genericError;
  } finally {
    if (key !== undefined && currentClient() === c) setWork(key, undefined);
    clearProgress();
    // The TV does not push source changes: ask for the state again (cheap when nothing changed).
    if (currentClient() === c) c.getState();
  }
  if (err && opts.attached && !opts.attached()) {
    if (currentClient() === c) showNotice(err);
    return undefined;
  }
  return err;
}

/**
 * An acknowledged change stays in the view this long when no TV layout follows (the change was a no-op on the TV,
 * so it pushed nothing). Re-applying it meanwhile is harmless: ops are intents with absolute targets.
 */
const ACK_HOLD_MS = 5_000;

/**
 * Sends a layout change. It shows at once (the same `applyOps` the TV runs, on the companion's view), goes out
 * as `ops` batches the TV accepts (`chunkOps`), and is reconciled when the TV answers: a `layoutChanged` or
 * `state` replaces the view (the TV wins), a failure reverts it and shows a notice. Returns the error copy, if any.
 */
export async function sendOps(ops: LayoutOp[]): Promise<string | undefined> {
  const c = currentClient();
  const base = optimistic.base();
  if (!c || !base) return COPY.genericError;
  if (ops.length === 0) return undefined;
  if (optimistic.check(ops).length > 0) {
    showNotice(COPY.opRejected);
    return COPY.opRejected;
  }
  const batches = chunkOps(ops);
  const ids = batches.map((batch) => optimistic.add(batch));
  publishLayout();
  if (import.meta.env.DEV) {
    markOpsSent();
    console.info(`[companion] ops sent at ${Date.now()}: ${ops.map((o) => o.op).join(', ')}`);
  }
  const errors = await Promise.all(batches.map(async (batch, i): Promise<string | undefined> => {
    const id = ids[i]!;
    let err: string | undefined;
    try {
      const r = await c.request({ t: 'ops', baseVersion: base.version, ops: batch });
      err = r.ok ? undefined : resultErrorCopy(r.error);
    } catch (e) {
      if (e instanceof RequestError && e.reason === 'timeout') err = COPY.timeout;
      else if (e instanceof Error && e.name === 'QueueFullError') err = COPY.busy;
      else err = COPY.genericError;
    }
    if (currentClient() !== c) return undefined;
    if (err) {
      optimistic.drop(id);
      publishLayout();
    } else {
      optimistic.ack(id);
      setTimeout(() => {
        if (currentClient() !== c) return;
        optimistic.drop(id);
        publishLayout();
      }, ACK_HOLD_MS);
    }
    return err;
  }));
  const err = errors.find((e) => e !== undefined);
  if (err) {
    showNotice(err);
    // Whatever went wrong, the TV's state is the truth: ask for it (cheap when nothing changed).
    c.getState();
  }
  return err;
}
