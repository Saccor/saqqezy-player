import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueFullError, type WebSocketFactory } from '@iptv/companion-protocol';
import { CompanionTransport } from './transport.ts';

/** A controllable WebSocket that also supports addEventListener (like the browser's). */
class FakeWs extends EventTarget {
  static all: FakeWs[] = [];
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    super();
    FakeWs.all.push(this);
  }
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    this.onopen?.({});
  }
  drop(code: number, reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
    this.onclose?.({ code, reason });
  }
}

const last = () => FakeWs.all[FakeWs.all.length - 1]!;
const flush = () => Promise.resolve().then(() => Promise.resolve());

function make(hidden: { v: boolean }) {
  const t = new CompanionTransport({
    url: 'ws://relay.example.test/v1/session/x/ws?role=phone',
    WebSocket: FakeWs as unknown as WebSocketFactory,
    deadline: Date.now() + 60 * 60_000,
    isHidden: () => hidden.v,
  });
  const ev = { open: 0, reconnected: 0, disconnected: 0, closed: [] as string[] };
  t.onOpen(() => ev.open++);
  t.onReconnected(() => ev.reconnected++);
  t.onDisconnected(() => ev.disconnected++);
  t.onClose((r) => ev.closed.push(r));
  return { t, ev };
}

/** Fails every new socket until the inner transport gives up (~60 s). */
async function failUntilGivenUp(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const before = FakeWs.all.length;
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(6_000);
    if (FakeWs.all.length === before) return; // no new attempt: gave up
  }
}

describe('CompanionTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it('reports each opened socket and forwards frames', async () => {
    const { t, ev } = make({ v: false });
    const frames: Uint8Array[] = [];
    t.onFrame((f) => frames.push(f));
    last().open();
    await flush();
    expect(ev.open).toBe(1);
    last().onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    expect(frames).toHaveLength(1);
    t.close();
  });

  it('ends on a final close code (4001: replaced) and never reconnects', async () => {
    const { ev } = make({ v: false });
    last().open();
    last().drop(4001);
    expect(ev.closed).toEqual(['replaced']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWs.all).toHaveLength(1);
  });

  it('ends with 4000 as expired', () => {
    const { ev } = make({ v: false });
    last().open();
    last().drop(4000);
    expect(ev.closed).toEqual(['expired']);
  });

  it('gives up as unreachable while the page is visible', async () => {
    const { ev } = make({ v: false });
    await failUntilGivenUp();
    expect(ev.closed).toEqual(['unreachable']);
  });

  it('parks instead of ending while hidden, then resumes with a fresh socket', async () => {
    const hidden = { v: true };
    const { t, ev } = make(hidden);
    await failUntilGivenUp();
    expect(ev.closed).toEqual([]);
    expect(t.parked).toBe(true);
    expect(() => t.send(new Uint8Array([1]))).toThrow(QueueFullError);
    expect(t.fits([1])).toBe(false);

    hidden.v = false;
    const count = FakeWs.all.length;
    t.resume();
    expect(FakeWs.all.length).toBe(count + 1);
    expect(t.parked).toBe(false);
    last().open();
    await flush();
    expect(ev.reconnected).toBe(1);
    t.send(new Uint8Array([9]));
    expect(last().sent).toHaveLength(1);
    t.close();
  });

  it('resume() skips the backoff wait and ignores the abandoned socket', async () => {
    const { t, ev } = make({ v: false });
    const first = last();
    first.open();
    await flush();
    first.drop(1006);
    expect(ev.disconnected).toBe(1);
    t.resume();
    const fresh = last();
    expect(fresh).not.toBe(first);
    fresh.open();
    await flush();
    expect(ev.reconnected).toBe(1);
    expect(ev.open).toBe(2);
    t.close();
  });

  it('gives up at the deadline on resume', () => {
    const { t, ev } = make({ v: false });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    t.resume();
    expect(ev.closed).toEqual(['deadline']);
  });
});
