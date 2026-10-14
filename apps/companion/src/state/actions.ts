import { RequestError } from '../connection/pending.ts';
import type { CompanionClient } from '../connection/client.ts';
import { COPY, resultErrorCopy } from '../logic/copy.ts';
import { createOpsSender } from '../logic/opsSender.ts';
import {
  clearProgress, currentClient, markOpsSent, nextWorkToken, optimistic, publishLayout, setWork, showNotice, store,
  type WorkOp,
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
  // A newer request for the same source replaces this marker; only the request that set a marker touches it.
  const token = nextWorkToken();
  const mine = () => key !== undefined && store.working[key]?.token === token;
  if (key !== undefined && op) setWork(key, { op, stalled: false, token });
  let err: string | undefined;
  try {
    const r = await c.request(msg, () => {
      stalled = true;
      if (key !== undefined && op && mine()) setWork(key, { op, stalled: true, token });
      opts.onStall?.();
    });
    err = r.ok ? undefined : resultErrorCopy(r.error);
  } catch (e) {
    if (e instanceof RequestError && e.reason === 'timeout') err = stalled ? undefined : COPY.timeout;
    else if (e instanceof Error && e.name === 'QueueFullError') err = COPY.busy;
    else err = COPY.genericError;
  } finally {
    if (key !== undefined && currentClient() === c && mine()) setWork(key, undefined);
    clearProgress();
    // The TV pushes source changes too, but asking right away is cheap (`stateUnchanged` when nothing changed).
    if (currentClient() === c) c.getState();
  }
  if (err && opts.attached && !opts.attached()) {
    if (currentClient() === c) showNotice(err);
    return undefined;
  }
  return err;
}

/**
 * Sends a layout change (see `createOpsSender`): it shows at once, goes out as `ops` batches one after another, and
 * is reconciled when the TV answers. Returns the error copy, if any (the notice is already shown).
 */
export const sendOps = createOpsSender({
  client: currentClient,
  sourceId: () => store.state?.activeSourceId,
  optimistic,
  publish: publishLayout,
  notice: showNotice,
  onBatchSent: import.meta.env.DEV
    ? (batch, bytes) => {
      markOpsSent();
      console.info(`[companion] ops sent at ${Date.now()}: ${batch.map((o) => o.op).join(', ')} (${bytes} bytes)`);
    }
    : undefined,
});
