import type { LayoutOp } from '@iptv/core';
import { RequestError, type ResultMessage } from '../connection/pending.ts';
import { chunkOps, utf8Length, type ChunkOptions } from './batches.ts';
import { COPY, resultErrorCopy } from './copy.ts';
import type { OptimisticLayout } from './optimistic.ts';

/**
 * Largest encoded `ops` message the companion sends. `chunkOps` aims for OPS_MESSAGE_BYTES, but order ops are never
 * split; one this big is refused before anything is shown or sent (it would crowd the 2 MiB send queue).
 */
export const MAX_OPS_MESSAGE_BYTES = 1024 * 1024;

/**
 * An acknowledged change stays in the view this long when no TV layout follows (the change was a no-op on the TV,
 * so it pushed nothing). Re-applying it meanwhile is harmless: ops are intents with absolute targets.
 */
export const ACK_HOLD_MS = 5_000;

/** The part of CompanionClient the sender uses. */
export interface OpsClient {
  request(msg: { t: 'ops'; baseVersion: number; ops: LayoutOp[] }): Promise<Pick<ResultMessage, 'ok' | 'error'>>;
  getState(): void;
}

export interface OpsSenderDeps {
  /** The live session's client (undefined when there is none). A change of client abandons the send. */
  client: () => OpsClient | undefined;
  optimistic: OptimisticLayout;
  /** Re-publish the optimistic view after it changed. */
  publish: () => void;
  notice: (text: string) => void;
  chunk?: ChunkOptions;
  /** Called as each batch goes out, with its encoded size (the DEV log). */
  onBatchSent?: (batch: LayoutOp[], bytes: number) => void;
}

/** UTF-8 size of the `ops` message as it goes on the wire (before encryption). */
export function opsMessageBytes(baseVersion: number, ops: readonly LayoutOp[]): number {
  return utf8Length(JSON.stringify({ t: 'ops', baseVersion, ops }));
}

function failureCopy(e: unknown): string {
  if (e instanceof RequestError && e.reason === 'timeout') return COPY.timeout;
  if (e instanceof Error && e.name === 'QueueFullError') return COPY.busy;
  return COPY.genericError;
}

/**
 * `sendOps(ops)`: a layout change shows at once (the same `applyOps` the TV runs, on the companion's view) and
 * goes out as `ops` batches the TV accepts (`chunkOps`), one after another: each batch waits for the TV's answer,
 * and the first failure stops the rest. A failed batch and every batch after it are reverted; batches the TV
 * already took stay (the next TV layout has them). On any failure the notice shows and the state is asked for again
 * (the TV wins). Returns the error copy, if any.
 */
export function createOpsSender(deps: OpsSenderDeps): (ops: LayoutOp[]) => Promise<string | undefined> {
  const fail = (err: string): string => {
    deps.notice(err);
    return err;
  };
  return async (ops) => {
    const c = deps.client();
    const base = deps.optimistic.base();
    if (!c || !base) return fail(COPY.genericError);
    if (ops.length === 0) return undefined;
    if (deps.optimistic.check(ops).length > 0) return fail(COPY.opRejected);
    const batches = chunkOps(ops, deps.chunk);
    const sizes = batches.map((b) => opsMessageBytes(base.version, b));
    if (sizes.some((n) => n > MAX_OPS_MESSAGE_BYTES)) return fail(COPY.tooLarge);

    const ids = batches.map((b) => deps.optimistic.add(b));
    deps.publish();
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const id = ids[i]!;
      deps.onBatchSent?.(batch, sizes[i]!);
      let err: string | undefined;
      try {
        const r = await c.request({ t: 'ops', baseVersion: base.version, ops: batch });
        if (!r.ok) err = resultErrorCopy(r.error);
      } catch (e) {
        err = failureCopy(e);
      }
      if (deps.client() !== c) return undefined; // the session went away: its view was reset
      if (err) {
        for (const rest of ids.slice(i)) deps.optimistic.drop(rest);
        deps.publish();
        deps.notice(err);
        c.getState();
        return err;
      }
      deps.optimistic.ack(id);
      setTimeout(() => {
        if (deps.client() !== c) return;
        deps.optimistic.drop(id);
        deps.publish();
      }, ACK_HOLD_MS);
    }
    return undefined;
  };
}
