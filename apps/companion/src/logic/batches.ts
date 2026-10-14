import { MAX_IDS, MAX_OPS_PER_BATCH, type LayoutOp } from '@iptv/core';

/**
 * Largest JSON size aimed for per `ops` message. The relay transport's send queue holds 2 MiB and refuses a
 * message that would not fit, so big id sets go out as several smaller messages.
 */
export const OPS_MESSAGE_BYTES = 512 * 1024;

export interface ChunkOptions {
  maxOps?: number;
  maxIds?: number;
  maxBytes?: number;
}

type IdOp = Extract<LayoutOp, { op: 'addToList' | 'removeFromList' | 'hideChannels' | 'unhideChannels' | 'hideGroups' | 'unhideGroups' }>;

/** Ops whose id set may be split into several ops of the same kind without changing the result. */
function idsOf(op: LayoutOp): string[] | undefined {
  switch (op.op) {
    case 'addToList':
    case 'removeFromList':
      return op.channelIds;
    case 'hideChannels':
    case 'unhideChannels':
    case 'hideGroups':
    case 'unhideGroups':
      return op.ids;
    default:
      return undefined;
  }
}

function withIds(op: IdOp, ids: string[]): LayoutOp {
  return op.op === 'addToList' || op.op === 'removeFromList' ? { ...op, channelIds: ids } : { ...op, ids };
}

const size = (op: LayoutOp): number => JSON.stringify(op).length + 1;

/**
 * Splits a change into `ops` batches the TV accepts: at most `maxOps` (MAX_OPS_PER_BATCH) ops per batch, at most
 * `maxIds` (MAX_IDS) ids per op, and about `maxBytes` of JSON per batch. Set-like ops (add/remove, hide/unhide)
 * are split; order ops (`setGroupOrder`, `setChannelOrder`) never are, because the full order must arrive whole.
 * Order is kept throughout.
 */
export function chunkOps(ops: readonly LayoutOp[], opts: ChunkOptions = {}): LayoutOp[][] {
  const maxOps = opts.maxOps ?? MAX_OPS_PER_BATCH;
  const maxIds = opts.maxIds ?? MAX_IDS;
  const maxBytes = opts.maxBytes ?? OPS_MESSAGE_BYTES;

  // 1. Split set-like ops by id count and by size.
  const pieces: LayoutOp[] = [];
  for (const op of ops) {
    const ids = idsOf(op);
    if (!ids) {
      pieces.push(op);
      continue;
    }
    const overhead = size(withIds(op as IdOp, []));
    let cur: string[] = [];
    let bytes = overhead;
    for (const id of ids) {
      const b = JSON.stringify(id).length + 1;
      if (cur.length > 0 && (cur.length >= maxIds || bytes + b > maxBytes)) {
        pieces.push(withIds(op as IdOp, cur));
        cur = [];
        bytes = overhead;
      }
      cur.push(id);
      bytes += b;
    }
    if (cur.length > 0 || ids.length === 0) pieces.push(withIds(op as IdOp, cur));
  }

  // 2. Group the pieces into batches.
  const batches: LayoutOp[][] = [];
  let batch: LayoutOp[] = [];
  let bytes = 2;
  for (const op of pieces) {
    const b = size(op);
    if (batch.length > 0 && (batch.length >= maxOps || bytes + b > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(op);
    bytes += b;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
