import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyLayout, type LayoutOp } from '@iptv/core';
import { COPY } from './copy.ts';
import { OptimisticLayout } from './optimistic.ts';
import { createOpsSender, MAX_OPS_MESSAGE_BYTES, opsMessageBytes, type OpsClient } from './opsSender.ts';

interface Call {
  sourceId: string;
  ops: LayoutOp[];
  resolve: (r: { ok: boolean; error?: { name: string; message: string } }) => void;
}

function setup(opts: { client?: boolean; maxBytes?: number; sourceId?: string | null } = {}) {
  const calls: Call[] = [];
  let getStates = 0;
  const client: OpsClient = {
    request: (msg) => new Promise((resolve) => calls.push({ sourceId: msg.sourceId, ops: msg.ops, resolve })),
    getState: () => { getStates++; },
  };
  const optimistic = new OptimisticLayout();
  optimistic.confirm(emptyLayout());
  const notices: string[] = [];
  let publishes = 0;
  const send = createOpsSender({
    client: () => (opts.client === false ? undefined : client),
    sourceId: () => (opts.sourceId === null ? undefined : opts.sourceId ?? 'src-a'),
    optimistic,
    publish: () => { publishes++; },
    notice: (t) => notices.push(t),
    ...(opts.maxBytes ? { chunk: { maxBytes: opts.maxBytes } } : {}),
  });
  return { send, calls, optimistic, notices, getStates: () => getStates, publishes: () => publishes };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createOpsSender', () => {
  it('without a connection, shows the notice and changes nothing', async () => {
    const s = setup({ client: false });
    const err = await s.send([{ op: 'setHideNoEpg', value: true }]);
    expect(err).toBe(COPY.genericError);
    expect(s.notices).toEqual([COPY.genericError]);
    expect(s.optimistic.pendingCount).toBe(0);
  });

  it('refuses a change the reducer would reject, before sending', async () => {
    const s = setup();
    const err = await s.send([{ op: 'deleteList', listId: 'fav' }]);
    expect(err).toBe(COPY.opRejected);
    expect(s.notices).toEqual([COPY.opRejected]);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a batch over 1 MiB before sending or showing it', async () => {
    const s = setup();
    const ids = Array.from({ length: 50_000 }, (_, i) => `channel-id-${String(i).padStart(12, '0')}`);
    const ops: LayoutOp[] = [{ op: 'setChannelOrder', groupId: 'g:A', ids }];
    expect(opsMessageBytes(0, ops)).toBeGreaterThan(MAX_OPS_MESSAGE_BYTES);
    const err = await s.send(ops);
    expect(err).toBe(COPY.tooLarge);
    expect(s.notices).toEqual([COPY.tooLarge]);
    expect(s.calls).toHaveLength(0);
    expect(s.optimistic.pendingCount).toBe(0);
    expect(s.publishes()).toBe(0);
  });

  it('applies the whole change at once, then sends its batches one after another', async () => {
    const s = setup({ maxBytes: 100 });
    const ids = Array.from({ length: 30 }, (_, i) => `ch-${i}`);
    const done = s.send([{ op: 'hideChannels', ids }]);
    await flush();
    expect(s.optimistic.view()!.hiddenChannels).toEqual(ids);
    const total = s.optimistic.pendingCount;
    expect(total).toBeGreaterThan(2);
    for (let i = 0; i < total; i++) {
      expect(s.calls).toHaveLength(i + 1); // the next one only goes out after this one is answered
      s.calls[i]!.resolve({ ok: true });
      await flush();
    }
    expect(await done).toBeUndefined();
    expect(s.calls.flatMap((c) => (c.ops[0] as { ids: string[] }).ids)).toEqual(ids);
    expect(s.notices).toEqual([]);
  });

  it('stops at the first failure: the rest is never sent and is reverted, the sent part stays', async () => {
    const s = setup({ maxBytes: 100 });
    const ids = Array.from({ length: 30 }, (_, i) => `ch-${i}`);
    const done = s.send([{ op: 'hideChannels', ids }]);
    await flush();
    const total = s.optimistic.pendingCount;
    expect(total).toBeGreaterThan(2);
    s.calls[0]!.resolve({ ok: true });
    await flush();
    s.calls[1]!.resolve({ ok: false, error: { name: 'Busy', message: 'x' } });
    expect(await done).toBe(COPY.busy);
    expect(s.calls).toHaveLength(2);
    expect(s.notices).toEqual([COPY.busy]);
    expect(s.getStates()).toBe(1);
    // Only the acknowledged first batch is still in the view (held until the TV's next layout).
    const first = (s.calls[0]!.ops[0] as { ids: string[] }).ids;
    expect(s.optimistic.view()!.hiddenChannels).toEqual(first);
    expect(s.optimistic.pendingCount).toBe(1);
  });

  it('holds an acknowledged batch until the hold expires when no TV layout follows', async () => {
    const s = setup();
    const done = s.send([{ op: 'setHideNoEpg', value: true }]);
    await flush();
    s.calls[0]!.resolve({ ok: true });
    expect(await done).toBeUndefined();
    expect(s.optimistic.view()!.hideNoEpg).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(s.optimistic.view()!.hideNoEpg).toBe(false);
  });
});

describe('createOpsSender source scoping', () => {
  it('sends every batch with the source id of the layout it was made on', async () => {
    const s = setup({ maxBytes: 100, sourceId: 'src-b' });
    const ids = Array.from({ length: 30 }, (_, i) => `ch-${i}`);
    const done = s.send([{ op: 'hideChannels', ids }]);
    await flush();
    const total = s.optimistic.pendingCount;
    for (let i = 0; i < total; i++) {
      s.calls[i]!.resolve({ ok: true });
      await flush();
    }
    await done;
    expect(s.calls.map((c) => c.sourceId)).toEqual(Array(total).fill('src-b'));
  });

  it('without an active source, nothing is sent', async () => {
    const s = setup({ sourceId: null });
    expect(await s.send([{ op: 'setHideNoEpg', value: true }])).toBe(COPY.genericError);
    expect(s.calls).toHaveLength(0);
  });

  it('WrongSource drops every pending change, even acknowledged ones, and asks for the state', async () => {
    const s = setup();
    const first = s.send([{ op: 'setHideNoEpg', value: true }]);
    await flush();
    s.calls[0]!.resolve({ ok: true });
    await first;
    const second = s.send([{ op: 'hideChannels', ids: ['ch-1'] }]);
    await flush();
    expect(s.optimistic.pendingCount).toBe(2);
    s.calls[1]!.resolve({ ok: false, error: { name: 'WrongSource', message: 'The TV switched to another source.' } });
    expect(await second).toBe('The TV switched to another source.');
    expect(s.optimistic.pendingCount).toBe(0);
    expect(s.optimistic.view()).toEqual(emptyLayout());
    expect(s.getStates()).toBe(1);
  });
});
