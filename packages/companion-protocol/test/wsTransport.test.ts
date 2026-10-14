import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BACKOFF_MAX_MS,
  HEARTBEAT_MS,
  PACE_MAX_FRAMES,
  PACE_WINDOW_MS,
  QUEUE_MAX_AGE_MS,
  QUEUE_MAX_BYTES,
  RECONNECT_GIVE_UP_MS,
  STABLE_MS,
  WebSocketRelayTransport,
  type WebSocketLike,
} from '../src/wsTransport.ts';
import { QueueFullError, SecureChannel } from '../src/channel.ts';
import { toB64Url } from '../src/b64.ts';

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
  /** Like a browser: throws while CONNECTING, silently drops the data while CLOSING or CLOSED. */
  send(data: Uint8Array | ArrayBuffer): void {
    if (this.readyState === 0) throw new Error('not open');
    if (this.readyState !== 1) return;
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
  serverClose(code: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.(reason === undefined ? { code } : { code, reason });
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

  test('a frame that would pass 2 MiB of queue is refused with QueueFullError; the transport stays up', () => {
    const { t, closes } = make();
    const big = new Uint8Array(256 * 1024);
    const fitting = QUEUE_MAX_BYTES / big.length;
    for (let i = 0; i < fitting; i++) t.send(big);
    expect(t.fits([1])).toBe(false);
    expect(() => t.send(big)).toThrow(QueueFullError);
    expect(closes).toEqual([]);
    last().serverOpen();
    expect(last().sent).toHaveLength(fitting);
    expect(t.fits([big.length])).toBe(true);
    t.send(frame(5));
    expect(last().sent.at(-1)![0]).toBe(5);
  });

  test('fits(): frames that go straight out need no queue room', () => {
    const { t } = make();
    const big = 1024 * 1024;
    // Not connected: everything queues.
    expect(t.fits([big, big])).toBe(true);
    expect(t.fits([big, big, 1])).toBe(false);
    last().serverOpen();
    // Connected with pacing budget: up to PACE_MAX_FRAMES frames go straight out.
    expect(t.fits(Array.from({ length: PACE_MAX_FRAMES }, () => big))).toBe(true);
    expect(t.fits(Array.from({ length: PACE_MAX_FRAMES + 3 }, () => big))).toBe(false);
    t.close();
    expect(t.fits([1])).toBe(false);
  });

  test('a 3 MiB message sent while disconnected is refused alone; the channel and the session stay up', async () => {
    vi.useRealTimers();
    const sessionId = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const t = new WebSocketRelayTransport({ url: URL_, WebSocket: FakeWs, random: () => 0.5 });
    const transportCloses: string[] = [];
    t.onClose((r) => transportCloses.push(r));
    // The phone role never compresses, so the payload stays 3 MiB on the wire.
    const ch = new SecureChannel<unknown, unknown>({
      secrets: { sessionId, key, sessionIdB64: toB64Url(sessionId) }, role: 'phone', transport: t, validate: (_x): _x is unknown => true,
    });
    const channelCloses: string[] = [];
    ch.onClose((r) => channelCloses.push(r));
    await expect(ch.send({ t: 'big', blob: 'x'.repeat(3 * 1024 * 1024) })).rejects.toBeInstanceOf(QueueFullError);
    expect(transportCloses).toEqual([]);
    expect(channelCloses).toEqual([]);
    // Nothing of it was queued: a small message is the only thing that goes out once the socket opens.
    await ch.send({ t: 'small' });
    last().serverOpen();
    expect(last().sent).toHaveLength(1);
    ch.close();
  });

  test('a CLOSING socket is never handed frames; they go out on the next socket', () => {
    const { t } = make();
    const first = last();
    first.serverOpen();
    first.readyState = 2; // CLOSING: a real socket would accept send() and drop the data
    t.send(frame(4));
    expect(first.sent).toHaveLength(0);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(first.sent).toHaveLength(0); // no ping either
    first.serverClose(1006);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    expect(last().sent.map((f) => f[0])).toEqual([4]);
  });

  test('a socket dropped by the flush in opened() is not reported as reconnected', () => {
    const { t, reconnects, disconnects } = make();
    last().serverOpen();
    last().serverClose(1006);
    t.send(frame(1));
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    const second = last();
    second.send = () => { throw new Error('broken'); };
    second.serverOpen();
    expect(reconnects()).toBe(0);
    expect(disconnects()).toBe(2);
    expect(second.closedWith).toBeDefined();
    // The frame is still queued for the next socket.
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    expect(last().sent.map((f) => f[0])).toEqual([1]);
    expect(reconnects()).toBe(1);
  });

  test('frames older than the queue age limit are dropped when a socket opens, not a give-up', () => {
    let clock = 0;
    const t = new WebSocketRelayTransport({ url: URL_, WebSocket: FakeWs, random: () => 0.5, now: () => clock });
    const closes: string[] = [];
    t.onClose((r) => closes.push(r));
    last().serverOpen();
    last().serverClose(1006);
    t.send(frame(1, 100));
    clock += QUEUE_MAX_AGE_MS + 10_000;
    t.send(frame(2, 50));
    // send() prunes the aged frame first.
    expect((t as unknown as { queuedBytes: number }).queuedBytes).toBe(50);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    expect(closes).toEqual([]);
    expect(last().sent.map((f) => f[0])).toEqual([2]);
    expect((t as unknown as { queuedBytes: number }).queuedBytes).toBe(0);
    t.send(frame(3));
    expect(last().sent.map((f) => f[0])).toEqual([2, 3]);
  });

  test('an aged frame takes every queued frame of its message with it: a message is never sent in part', () => {
    let clock = 0;
    const t = new WebSocketRelayTransport({ url: URL_, WebSocket: FakeWs, random: () => 0.5, now: () => clock });
    const q = () => (t as unknown as { queuedBytes: number }).queuedBytes;
    last().serverOpen();
    last().serverClose(1006);
    t.send(frame(1, 100), 7);
    clock += 30_000;
    t.send(frame(2, 100), 7); // same message, queued later (younger)
    t.send(frame(5, 10), 8);
    clock += QUEUE_MAX_AGE_MS - 20_000; // frame 1 is now aged, frame 2 is not
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    expect(last().sent.map((f) => f[0])).toEqual([5]);
    expect(q()).toBe(0);
    // The rest of message 7, still being sent, is discarded too.
    t.send(frame(3, 10), 7);
    t.send(frame(6, 10), 9);
    expect(last().sent.map((f) => f[0])).toEqual([5, 6]);
  });

  test('fits() and send() prune aged frames first, so stale frames do not hold queue room', () => {
    let clock = 0;
    const t = new WebSocketRelayTransport({ url: URL_, WebSocket: FakeWs, random: () => 0.5, now: () => clock });
    last().serverOpen();
    last().serverClose(1006);
    const big = QUEUE_MAX_BYTES - 1000;
    t.send(frame(1, big), 1);
    expect(t.fits([2000])).toBe(false);
    clock += QUEUE_MAX_AGE_MS + 1;
    expect(t.fits([2000])).toBe(true);
    expect((t as unknown as { queuedBytes: number }).queuedBytes).toBe(0);
    t.send(frame(2, big), 2);
    clock += QUEUE_MAX_AGE_MS + 1;
    expect(() => t.send(frame(3, 2000), 3)).not.toThrow();
    expect((t as unknown as { queuedBytes: number }).queuedBytes).toBe(2000);
  });

  test('when ws.send throws partway through a message, its remaining queued frames are dropped', () => {
    const { t } = make();
    const first = last();
    first.serverOpen();
    let calls = 0;
    const realSend = first.send.bind(first);
    first.send = (d) => {
      if (++calls === 2) throw new Error('broken');
      realSend(d);
    };
    t.send(frame(1), 7); // goes out
    t.send(frame(2), 7); // throws: the socket is dropped, this frame stays queued
    t.send(frame(3), 7); // queued behind it
    t.send(frame(9), 8); // a later whole message
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    // Frames 2 and 3 of message 7 would be a partial message: only message 8 goes out.
    expect(last().sent.map((f) => f[0])).toEqual([9]);
    expect((t as unknown as { queuedBytes: number }).queuedBytes).toBe(0);
  });

  test('a socket that drops mid-message does not deliver the rest of that message on the next socket', () => {
    const { t } = make();
    last().serverOpen();
    t.send(frame(1), 5);
    last().readyState = 2; // CLOSING: the rest of the message queues behind it
    t.send(frame(2), 5);
    t.send(frame(3), 6);
    last().serverClose(1006);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    expect(last().sent.map((f) => f[0])).toEqual([3]);
  });

  test('a message of which nothing was sent before a throw stays queued whole', () => {
    const { t } = make();
    const first = last();
    first.serverOpen();
    first.send = () => { throw new Error('broken'); };
    t.send(frame(1), 7);
    t.send(frame(2), 7);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    last().serverOpen();
    expect(last().sent.map((f) => f[0])).toEqual([1, 2]);
  });

  test('4003 with reason quota is reported as quota', () => {
    const { closes } = make();
    last().serverOpen();
    last().serverClose(4003, 'quota');
    expect(closes).toEqual(['quota']);
  });

  test('no timers are left after close() or after a give-up', () => {
    const a = make({ deadline: Date.now() + 60_000 });
    last().serverOpen();
    a.t.send(frame(1));
    a.t.close();
    expect(vi.getTimerCount()).toBe(0);
    const b = make({ deadline: Date.now() + 60_000 });
    last().serverOpen();
    last().serverClose(4000);
    expect(b.closes).toEqual(['expired']);
    expect(vi.getTimerCount()).toBe(0);
    const c = make();
    for (let i = 0; i < 200 && c.closes.length === 0; i++) {
      last().serverClose(1006);
      vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    }
    expect(c.closes).toEqual(['unreachable']);
    expect(vi.getTimerCount()).toBe(0);
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
