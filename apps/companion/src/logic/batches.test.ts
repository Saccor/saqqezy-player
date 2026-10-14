import { describe, expect, it } from 'vitest';
import { isLayoutOpBatch, MAX_IDS, MAX_OPS_PER_BATCH, type LayoutOp } from '@iptv/core';
import { chunkOps, utf8Length } from './batches.ts';

const ids = (n: number, p = 'ch') => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe('chunkOps', () => {
  it('keeps a small change as one batch', () => {
    const ops: LayoutOp[] = [{ op: 'setHideNoEpg', value: true }, { op: 'renameChannel', id: 'a', name: 'B' }];
    expect(chunkOps(ops)).toEqual([ops]);
    expect(chunkOps([])).toEqual([]);
  });

  it('puts 600 channels into one addToList op', () => {
    const batches = chunkOps([{ op: 'addToList', listId: 'l', channelIds: ids(600) }]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect((batches[0]![0] as { channelIds: string[] }).channelIds).toHaveLength(600);
  });

  it('splits an id array above MAX_IDS into several ops, in order', () => {
    const all = ids(MAX_IDS + 10);
    const batches = chunkOps([{ op: 'addToList', listId: 'l', channelIds: all }], { maxBytes: Infinity });
    const ops = batches.flat() as { op: string; channelIds: string[] }[];
    expect(ops.length).toBe(2);
    expect(ops.every((o) => o.op === 'addToList' && o.channelIds.length <= MAX_IDS)).toBe(true);
    expect(ops.flatMap((o) => o.channelIds)).toEqual(all);
    for (const b of batches) expect(isLayoutOpBatch(b)).toBe(true);
  });

  it('keeps every batch at or below MAX_OPS_PER_BATCH, in order', () => {
    const ops: LayoutOp[] = ids(1201).map((id) => ({ op: 'renameChannel', id, name: 'N' }));
    const batches = chunkOps(ops);
    expect(batches.map((b) => b.length)).toEqual([MAX_OPS_PER_BATCH, MAX_OPS_PER_BATCH, 201]);
    expect(batches.flat()).toEqual(ops);
  });

  it('splits by size so a message stays small enough for the send queue', () => {
    const all = ids(40_000, 'source-with-a-long-id:abcdef');
    const batches = chunkOps([{ op: 'hideChannels', ids: all }], { maxBytes: 256 * 1024 });
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(JSON.stringify(b).length).toBeLessThanOrEqual(256 * 1024 + 64);
    expect(batches.flat().flatMap((o) => (o as { ids: string[] }).ids)).toEqual(all);
  });

  it('never splits an order op (the full order must arrive in one op)', () => {
    const order = ids(30_000, 'long-channel-identifier-');
    const batches = chunkOps([{ op: 'setChannelOrder', groupId: 'g:A', ids: order }], { maxBytes: 1024 });
    expect(batches).toEqual([[{ op: 'setChannelOrder', groupId: 'g:A', ids: order }]]);
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    const enc = new TextEncoder();
    // Each id is 10 characters but 26 bytes in UTF-8 (eight 3-byte characters).
    const wide = Array.from({ length: 200 }, (_, i) => '€'.repeat(8) + String(i % 100).padStart(2, '0'));
    const maxBytes = 2048;
    const batches = chunkOps([{ op: 'hideChannels', ids: wide }], { maxBytes });
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(enc.encode(JSON.stringify(b)).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(batches.flat().flatMap((o) => (o as { ids: string[] }).ids)).toEqual(wide);
  });
});

describe('utf8Length', () => {
  it('matches TextEncoder for ASCII, 2-, 3- and 4-byte characters and lone surrogates', () => {
    const enc = new TextEncoder();
    for (const s of ['', 'abc', 'café', '€', '\u{1F4FA} tv', 'x\ud800y', '\udc00', '\ud800']) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(enc.encode(s).byteLength);
    }
  });
});
