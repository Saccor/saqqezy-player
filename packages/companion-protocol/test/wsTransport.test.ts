import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  HEARTBEAT_MS,
  PACE_MAX_FRAMES,
  PACE_WINDOW_MS,
  QUEUE_MAX_BYTES,
  RECONNECT_GIVE_UP_MS,
  STABLE_MS,
  WebSocketRelayTransport,
  type WebSocketLike,
} from '../src/wsTransport.ts';

/** A scriptable stand-in for the browser WebSocket. */
class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(data: Uint8Array | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  // Test helpers: what the server or the network does.
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  serverError(): void {
    this.onerror?.({});
  }
}

const last = () => FakeWs.all[FakeWs.all.length - 1]!;
const URL_ = 'ws://relay.example.test/v1/session/abc/ws?role=tv';
const frame = (n: number, size = 4) => new Uint8Array(size).fill(n);

function make(opts: { deadline?: number } = {}) {
  const t = new WebSocketRelayTransport({ url: URL_, WebSocket: FakeWs, random: () => 0.5, ...opts });
  const frames: Uint8Array[] = [];
  const closes: string[] = [];
  let reconnects = 0;
  let disconnects = 0;
  t.onFrame((f) => frames.push(f));
  t.onClose((r) => closes.push(r));
  t.onReconnected(() => { reconnects++; });
  t.onDisconnected(() => { disconnects++; });
  return { t, frames, closes, reconnects: () => reconnects, disconnects: () => disconnects };
}

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WebSocketRelayTransport', () => {
  test('connects to the URL with arraybuffer frames and flushes frames queued before open, in order', () => {
    const { t } = make();
    expect(FakeWs.all).toHaveLength(1);
    expect(last().url).toBe(URL_);
    expect(last().binaryType).toBe('arraybuffer');
    t.send(frame(1));
    t.send(frame(2));
    expect(last().sent).toHaveLength(0);
    last().serverOpen();
    expect(last().sent.map((f) => f[0])).toEqual([1, 2]);
    t.send(frame(3));
    expect(last().sent.map((f) => f[0])).toEqual([1, 2, 3]);
  });

  test('delivers binary frames; ignores pings (0 bytes) and text', () => {
    const { frames } = make();
    last().serverOpen();
    last().serverMessage(new Uint8Array([7, 8]).buffer);
    last().serverMessage(new ArrayBuffer(0));
    last().serverMessage('hello');
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual([7, 8]);
  });

  test('sends a 0-byte heartbeat every 30 s while connected', () => {
    make();
    last().serverOpen();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(last().sent.map((f) => f.byteLength)).toEqual([0]);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(last().sent).toHaveLength(2);
  });

  test('reconnects on 1006; send never throws meanwhile; queued frames are flushed and onReconnected fires', () => {
    const { t, closes, reconnects, disconnects } = make();
    const first = last();
    first.serverOpen();
    first.serverClose(1006);
    expect(disconnects()).toBe(1);
    expect(() => t.send(frame(9))).not.toThrow();
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeWs.all).toHaveLength(2);
    const second = last();
    expect(second.binaryType).toBe('arraybuffer');
    second.serverOpen();
    expect(second.sent.map((f) => f[0])).toEqual([9]);
    expect(reconnects()).toBe(1);
    expect(closes).toEqual([]);
  });

  test.each([1001, 1011, 1012])('reconnects on %i', (code) => {
    const { closes } = make();
    last().serverOpen();
    last().serverClose(code);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeWs.all).toHaveLength(2);
    expect(closes).toEqual([]);
  });

  test('reconnects after a socket error and ignores every later event of the abandoned socket', () => {
    const { frames, closes } = make();
    const first = last();
    first.serverOpen();
    first.serverError();
    expect(first.closedWith).toBeDefined();
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeWs.all).toHaveLength(2);
    // Late events from the old socket.
    first.serverMessage(new Uint8Array([1]).buffer);
    first.serverClose(4001);
    expect(frames).toHaveLength(0);
    expect(closes).toEqual([]);
  });

  test.each([
    [4000, 'expired'], [4001, 'replaced'], [4002, 'too-large'], [4003, 'rate-limit'], [4004, 'bad-role'], [1003, 'protocol'],
  ])('close code %i is final (%s): onClose fires, no reconnect', (code, reason) => {
    const { t, closes } = make();
    last().serverOpen();
    last().serverClose(code);
    expect(closes).toEqual([reason]);
    vi.advanceTimersByTime(RECONNECT_GIVE_UP_MS * 2);
    expect(FakeWs.all).toHaveLength(1);
    expect(() => t.send(frame(1))).toThrow();
  });

  test('gives up after about 60 s of consecutive failures', () => {
    const t0 = Date.now();
    const { closes } = make();
    for (let i = 0; i < 200 && closes.length === 0; i++) {
      last().serverClose(1006);
      vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    }
    expect(closes).toEqual(['unreachable']);
    expect(Date.now() - t0).toBeLessThan(RECONNECT_GIVE_UP_MS + BACKOFF_MAX_MS * 3);
  });

  test('sockets that open and drop at once do not reset the failure window', () => {
    const { closes } = make();
    for (let i = 0; i < 200 && closes.length === 0; i++) {
      last().serverOpen();
      last().serverClose(1006);
      vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    }
    expect(closes).toEqual(['unreachable']);
  });

  test('a connection that stays up for 3 s resets the failure window', () => {
    const { closes } = make();
    for (let round = 0; round < 3; round++) {
      // ~50 s of failures, then a stable connection.
      const start = Date.now();
      while (Date.now() - start < RECONNECT_GIVE_UP_MS - 10_000) {
        last().serverClose(1006);
        vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
      }
      last().serverOpen();
      vi.advanceTimersByTime(STABLE_MS);
    }
    expect(closes).toEqual([]);
  });

  test('a connection attempt that never opens counts as a failure', () => {
    const { closes } = make();
    vi.advanceTimersByTime(RECONNECT_GIVE_UP_MS + BACKOFF_MAX_MS * 4);
    expect(FakeWs.all.length).toBeGreaterThan(1);
    expect(closes).toEqual(['unreachable']);
  });

  test('paces outgoing frames below the relay rate limit (pings included)', () => {
    const { t } = make();
    last().serverOpen();
    for (let i = 0; i < PACE_MAX_FRAMES + 50; i++) t.send(frame(i & 255));
    expect(last().sent).toHaveLength(PACE_MAX_FRAMES);
    expect(PACE_MAX_FRAMES).toBeLessThan(200);
    vi.advanceTimersByTime(PACE_WINDOW_MS + 1);
    expect(last().sent).toHaveLength(PACE_MAX_FRAMES + 50);
  });

  test('the pacing window carries over a reconnect', () => {
    const { t } = make();
    last().serverOpen();
    for (let i = 0; i < PACE_MAX_FRAMES; i++) t.send(frame(1));
    last().serverClose(1006);
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    t.send(frame(2));
    last().serverOpen();
    // Still inside the window of the earlier frames: nothing may go out yet.
    expect(last().sent).toHaveLength(0);
    vi.advanceTimersByTime(PACE_WINDOW_MS + 1);
    expect(last().sent.some((f) => f[0] === 2)).toBe(true);
  });

  test('a queue over 2 MiB gives up', () => {
    const { t, closes } = make();
    const big = new Uint8Array(256 * 1024);
    for (let i = 0; i * big.length <= QUEUE_MAX_BYTES; i++) t.send(big);
    expect(closes).toEqual(['queue-overflow']);
  });

  test('gives up at the session deadline', () => {
    const { closes } = make({ deadline: Date.now() + 5_000 });
    last().serverOpen();
    vi.advanceTimersByTime(5_000);
    expect(closes).toEqual(['deadline']);
    expect(last().closedWith).toBeDefined();
  });

  test('close() closes the socket for good, without onClose or reconnects', () => {
    const { t, closes } = make();
    last().serverOpen();
    t.close();
    expect(last().closedWith).toBe(1000);
    last().serverClose(1006);
    vi.advanceTimersByTime(RECONNECT_GIVE_UP_MS);
    expect(FakeWs.all).toHaveLength(1);
    expect(closes).toEqual([]);
    expect(() => t.send(frame(1))).toThrow();
  });
});
