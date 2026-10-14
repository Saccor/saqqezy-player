import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRequests, REQUEST_TIMEOUT_MS, RequestError, STALLED_MAX_MS } from './pending.ts';

describe('PendingRequests', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves the request with the matching result', async () => {
    const p = new PendingRequests();
    const a = p.add(7);
    const b = p.add(8);
    expect(p.resolve({ t: 'result', requestMsgId: 8, ok: true })).toBe(true);
    expect(p.resolve({ t: 'result', requestMsgId: 7, ok: true })).toBe(true);
    await expect(a).resolves.toEqual({ t: 'result', requestMsgId: 7, ok: true });
    await expect(b).resolves.toEqual({ t: 'result', requestMsgId: 8, ok: true });
    expect(p.size).toBe(0);
  });

  it('resolves failed results too (the caller decides how to show them)', async () => {
    const p = new PendingRequests();
    const a = p.add(1);
    const error = { name: 'ValidationError', message: 'Enter a server address.' };
    p.resolve({ t: 'result', requestMsgId: 1, ok: false, error });
    await expect(a).resolves.toEqual({ t: 'result', requestMsgId: 1, ok: false, error });
  });

  it('ignores a result nobody waits for', () => {
    const p = new PendingRequests();
    expect(p.resolve({ t: 'result', requestMsgId: 99, ok: true })).toBe(false);
  });

  it('rejects with a timeout after 30 s', async () => {
    const p = new PendingRequests();
    const a = p.add(3);
    const caught = a.catch((e: unknown) => e);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    expect(p.size).toBe(1);
    vi.advanceTimersByTime(1);
    const err = await caught;
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).reason).toBe('timeout');
    expect(p.size).toBe(0);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('a late result after the timeout is ignored', async () => {
    const p = new PendingRequests();
    const a = p.add(3).catch(() => 'timed out');
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(a).resolves.toBe('timed out');
    expect(p.resolve({ t: 'result', requestMsgId: 3, ok: true })).toBe(false);
  });

  it('rejects every request on close, and later adds at once', async () => {
    const p = new PendingRequests();
    const a = p.add(1).catch((e: unknown) => e);
    const b = p.add(2).catch((e: unknown) => e);
    p.closeAll();
    for (const r of [await a, await b]) {
      expect(r).toBeInstanceOf(RequestError);
      expect((r as RequestError).reason).toBe('closed');
    }
    expect(p.size).toBe(0);
    const c = await p.add(3).catch((e: unknown) => e);
    expect((c as RequestError).reason).toBe('closed');
  });

  it('cancel drops a request without settling it, and clears its timer', async () => {
    const p = new PendingRequests();
    let settled = false;
    void p.add(5).then(() => { settled = true; }, () => { settled = true; });
    p.cancel(5);
    expect(p.size).toBe(0);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 2);
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('takes a custom timeout', async () => {
    const p = new PendingRequests();
    const a = p.add(1, 1000).catch((e: unknown) => (e as RequestError).reason);
    vi.advanceTimersByTime(1000);
    await expect(a).resolves.toBe('timeout');
  });

  describe('idle requests', () => {
    it('stall after the idle time without settling, and a later result still resolves them', async () => {
      const p = new PendingRequests();
      let stalls = 0;
      const a = p.add(4, 60_000, { onStall: () => stalls++ });
      vi.advanceTimersByTime(60_000);
      expect(stalls).toBe(1);
      expect(p.size).toBe(1);
      p.resolve({ t: 'result', requestMsgId: 4, ok: true });
      await expect(a).resolves.toEqual({ t: 'result', requestMsgId: 4, ok: true });
    });

    it('touch() restarts the idle time of requests that have not stalled', () => {
      const p = new PendingRequests();
      let stalls = 0;
      void p.add(4, 60_000, { onStall: () => stalls++ });
      vi.advanceTimersByTime(50_000);
      p.touch();
      vi.advanceTimersByTime(50_000);
      expect(stalls).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(stalls).toBe(1);
    });

    it('touch() leaves plain requests alone', async () => {
      const p = new PendingRequests();
      const a = p.add(3, 1000).catch((e: unknown) => (e as RequestError).reason);
      vi.advanceTimersByTime(900);
      p.touch();
      vi.advanceTimersByTime(100);
      await expect(a).resolves.toBe('timeout');
    });

    it('a stalled request is given up silently-as-timeout after STALLED_MAX_MS', async () => {
      const p = new PendingRequests();
      const a = p.add(4, 60_000, { onStall: () => {} }).catch((e: unknown) => (e as RequestError).reason);
      vi.advanceTimersByTime(60_000 + STALLED_MAX_MS);
      await expect(a).resolves.toBe('timeout');
      expect(p.size).toBe(0);
    });
  });
});
