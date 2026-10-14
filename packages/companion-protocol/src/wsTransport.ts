import { QueueFullError, type RelayTransport } from './channel.ts';

/**
 * A long-lived relay transport over WebSocket, shared by the TV worker and the companion app.
 *
 * It implements the `RelayTransport` contract and the client close-code policy of Plan 4:
 * - One instance per SecureChannel. Dropped sockets are replaced internally; the channel never notices.
 * - Final close codes fire `onClose` at once and never reconnect: 4000 (expired/idle), 4001 (replaced),
 *   4002 (too large), 4003 (rate limit/connects/quota), 4004 (bad role), 1003 (text frame).
 * - Every other close (1001, 1006, 1011, 1012, unknown codes), a socket error, or an attempt that does not
 *   open within CONNECT_TIMEOUT_MS, reconnects with exponential backoff and jitter. After about
 *   RECONNECT_GIVE_UP_MS of consecutive failures, or at the session deadline, it gives up and fires `onClose`.
 * - The backoff and the failure window reset only after the first frame arrives on a new socket, or once it
 *   has stayed open for STABLE_MS.
 * - Events from an abandoned socket (replaced or given up) are ignored.
 * - While reconnecting (or while pacing), frames queue: at most QUEUE_MAX_BYTES, each at most QUEUE_MAX_AGE_MS old.
 *   A frame that would push the queue past QUEUE_MAX_BYTES is refused with a non-final `QueueFullError`; nothing
 *   is queued and the transport stays up. `fits()` lets the channel check a whole message before sending any of
 *   it. When a socket opens (or the pacing timer fires), queued frames older than QUEUE_MAX_AGE_MS are dropped
 *   (and `queuedBytes` updated) instead of giving up: the peer tolerates the gaps and both sides re-sync after a
 *   reconnect (the companion asks `getState{ haveVersion }`, the TV re-pushes the layout).
 *   After a final close `send()` throws.
 * - No half-sent messages: `send(frame, messageId)` groups the frames of one message. If the socket drops, or
 *   `ws.send` throws, after some frames of a message went out, that message's remaining queued frames are
 *   dropped rather than sent on the next socket. (The peer's partial reassembly times out; both sides re-sync.)
 *   A message of which nothing went out stays queued whole.
 * - Frames are only dequeued while the socket's `readyState` is OPEN (a CLOSING socket would drop them).
 * - Outgoing frames are paced below the relay's 200 frames per 10 s (pings included, across reconnects).
 * - A 0-byte binary ping goes out every HEARTBEAT_MS while connected; incoming 0-byte frames are ignored.
 * - `binaryType = 'arraybuffer'`; only binary frames are sent and only binary frames are delivered.
 * - `close()` is the owner's own close: no `onClose`, no reconnect.
 *
 * Never logs anything: the URL contains the session id.
 */

/** The parts of the browser WebSocket this transport uses (tests inject a fake). */
export interface WebSocketLike {
  binaryType: string;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** The browser's `WebSocket` (cast: its handler types are narrower than WebSocketLike's). */
export type WebSocketFactory = new (url: string) => WebSocketLike;

export type TransportCloseReason =
  | 'expired' | 'replaced' | 'too-large' | 'rate-limit' | 'quota' | 'bad-role' | 'protocol'
  | 'unreachable' | 'deadline' | 'queue-overflow';

export interface WsTransportOptions {
  url: string;
  WebSocket: WebSocketFactory;
  /** Absolute time (ms, same clock as `now`) after which the session is over: the transport gives up. */
  deadline?: number;
  now?: () => number;
  /** For backoff jitter; tests pin it. */
  random?: () => number;
}

export const HEARTBEAT_MS = 30_000;
export const RECONNECT_GIVE_UP_MS = 60_000;
export const STABLE_MS = 3_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 5_000;
export const QUEUE_MAX_BYTES = 2 * 1024 * 1024;
export const QUEUE_MAX_AGE_MS = 60_000;
/** Frames (pings included) per PACE_WINDOW_MS; kept well below the relay's 200 to absorb clock skew. */
export const PACE_MAX_FRAMES = 180;
export const PACE_WINDOW_MS = 10_000;

/** WebSocket readyState OPEN. */
const OPEN = 1;

const FINAL_CODES: ReadonlyMap<number, TransportCloseReason> = new Map([
  [4000, 'expired'],
  [4001, 'replaced'],
  [4002, 'too-large'],
  [4003, 'rate-limit'],
  [4004, 'bad-role'],
  [1003, 'protocol'],
]);

type Timer = ReturnType<typeof setTimeout>;

export class WebSocketRelayTransport implements RelayTransport {
  private readonly url: string;
  private readonly WS: WebSocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;

  private ws: WebSocketLike | null = null;
  private isOpen = false;
  private everOpened = false;
  private final = false;
  private stable = false;
  private attempt = 0;
  /** Start of the current run of failures; null once a connection proved stable. */
  private failingSince: number | null;

  private queue: { frame: Uint8Array; at: number; group: number | undefined }[] = [];
  private queuedBytes = 0;
  /** The message of the last frame handed to a socket; its still-queued frames are a partial message if that socket dies. */
  private lastSentGroup: number | undefined;
  /** A message whose queued frames were just dropped: the rest of its frames, still being sent, are discarded too. */
  private discardGroup: number | undefined;
  /** Send times of the last PACE_WINDOW_MS (pings included). Kept across reconnects, like the relay's window. */
  private sentTimes: number[] = [];

  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private stableTimer: Timer | undefined;
  private connectTimer: Timer | undefined;
  private retryTimer: Timer | undefined;
  private paceTimer: Timer | undefined;
  private deadlineTimer: Timer | undefined;

  private readonly frameListeners = new Set<(f: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly reconnectedListeners = new Set<() => void>();
  private readonly disconnectedListeners = new Set<() => void>();

  constructor(opts: WsTransportOptions) {
    this.url = opts.url;
    this.WS = opts.WebSocket;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.failingSince = this.now();
    if (opts.deadline !== undefined) {
      this.deadlineTimer = setTimeout(() => this.giveUp('deadline'), Math.max(0, opts.deadline - this.now()));
    }
    this.connect();
  }

  /** Queues one frame and sends what the pacing allows. Throws QueueFullError (non-final) when the queue is full. */
  send(frame: Uint8Array, messageId?: number): void {
    if (this.final) throw new Error('transport closed');
    if (messageId !== undefined && messageId === this.discardGroup) return; // the rest of a message already cut
    this.discardGroup = undefined;
    if (!this.fits([frame.byteLength])) throw new QueueFullError();
    this.queue.push({ frame, at: this.now(), group: messageId });
    this.queuedBytes += frame.byteLength;
    this.pump();
  }

  /**
   * True when frames of these sizes, sent now in order, would all be accepted: the ones that go straight out
   * (socket open, queue empty, pacing budget left) need no room; the rest must fit in the queue.
   */
  fits(frameBytes: readonly number[]): boolean {
    if (this.final) return false;
    let direct = this.isOpen && this.ws?.readyState === OPEN && this.queue.length === 0 ? this.budget(this.now()) : 0;
    let bytes = this.queuedBytes;
    for (const n of frameBytes) {
      if (direct > 0) {
        direct--;
        continue;
      }
      bytes += n;
      if (bytes > QUEUE_MAX_BYTES) return false;
    }
    return true;
  }

  onFrame(fn: (f: Uint8Array) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /** Fires once, on a final give-up. Never after `close()`. */
  onClose(fn: (reason: string) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /** Fires each time a replacement socket opened (not on the first connection). */
  onReconnected(fn: () => void): () => void {
    this.reconnectedListeners.add(fn);
    return () => this.reconnectedListeners.delete(fn);
  }

  /** Fires when an open socket dropped and a reconnect starts. */
  onDisconnected(fn: () => void): () => void {
    this.disconnectedListeners.add(fn);
    return () => this.disconnectedListeners.delete(fn);
  }

  close(): void {
    if (this.final) return;
    this.final = true;
    this.teardown();
    this.clearListeners();
  }

  // ---- internals ----

  private connect(): void {
    if (this.final) return;
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.dropped();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && !this.isOpen) this.dropped();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws === ws && !this.final) this.opened();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws && !this.final) this.message(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.final) return;
      // 4003 covers the per-role rate, the connect rate and the session quota; only the quota says so.
      const reason = ev.code === 4003 && ev.reason === 'quota' ? 'quota' : FINAL_CODES.get(ev.code);
      if (reason) this.giveUp(reason);
      else this.dropped();
    };
    ws.onerror = () => {
      if (this.ws === ws && !this.final) this.dropped();
    };
  }

  private opened(): void {
    clearTimeout(this.connectTimer);
    this.isOpen = true;
    const reconnect = this.everOpened;
    this.everOpened = true;
    this.stable = false;
    this.stableTimer = setTimeout(() => this.markStable(), STABLE_MS);
    this.heartbeatTimer = setInterval(() => this.ping(), HEARTBEAT_MS);
    const ws = this.ws;
    this.pump();
    // pump() may have dropped this socket (a throwing send) or given up: then it is not a reconnect.
    if (this.ws !== ws || !this.isOpen || this.final) return;
    if (reconnect) this.fire(this.reconnectedListeners);
  }

  private markStable(): void {
    if (this.stable) return;
    this.stable = true;
    this.attempt = 0;
    this.failingSince = null;
    clearTimeout(this.stableTimer);
  }

  private message(data: unknown): void {
    let frame: Uint8Array;
    if (data instanceof ArrayBuffer) frame = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return; // text: never expected from the relay
    if (!this.stable) this.markStable();
    if (frame.byteLength === 0) return; // ping
    for (const fn of [...this.frameListeners]) {
      try {
        fn(frame);
      } catch {
        // A listener's error must not break the transport.
      }
    }
  }

  /** The current socket is gone (or never opened): abandon it and retry with backoff. */
  private dropped(): void {
    const wasOpen = this.isOpen;
    this.abandonSocket();
    this.dropPartial();
    if (wasOpen) this.fire(this.disconnectedListeners);
    if (this.final) return;
    const now = this.now();
    this.failingSince ??= now;
    if (now - this.failingSince >= RECONNECT_GIVE_UP_MS) {
      this.giveUp('unreachable');
      return;
    }
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    const delay = Math.min(BACKOFF_MAX_MS, base * (0.8 + 0.4 * this.random()));
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private abandonSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.isOpen = false;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.paceTimer);
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close(1000);
    } catch {
      // Already closed.
    }
  }

  /** Drops the queued rest of a message that was partly sent on the socket that just went away. */
  private dropPartial(): void {
    const g = this.lastSentGroup;
    this.lastSentGroup = undefined;
    if (g === undefined) return;
    this.discardGroup = g;
    this.queue = this.queue.filter((item) => {
      if (item.group !== g) return true;
      this.queuedBytes -= item.frame.byteLength;
      return false;
    });
  }

  private teardown(): void {
    this.abandonSocket();
    clearTimeout(this.retryTimer);
    clearTimeout(this.deadlineTimer);
    this.queue = [];
    this.queuedBytes = 0;
  }

  private giveUp(reason: TransportCloseReason): void {
    if (this.final) return;
    this.final = true;
    this.teardown();
    for (const fn of [...this.closeListeners]) {
      try {
        fn(reason);
      } catch {
        // Ignore listener errors.
      }
    }
    this.clearListeners();
  }

  private clearListeners(): void {
    this.frameListeners.clear();
    this.closeListeners.clear();
    this.reconnectedListeners.clear();
    this.disconnectedListeners.clear();
  }

  private fire(listeners: Set<() => void>): void {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // Ignore listener errors.
      }
    }
  }

  /** Frames still allowed in the current pacing window. */
  private budget(now: number): number {
    const from = now - PACE_WINDOW_MS;
    while (this.sentTimes.length && this.sentTimes[0]! <= from) this.sentTimes.shift();
    return PACE_MAX_FRAMES - this.sentTimes.length;
  }

  private pump(): void {
    clearTimeout(this.paceTimer);
    this.paceTimer = undefined;
    const ws = this.ws;
    if (!this.isOpen || !ws || this.final) return;
    // A CLOSING socket accepts send() and silently drops the data: keep the frames for the next socket.
    if (ws.readyState !== OPEN) return;
    const now = this.now();
    // Too old to be worth sending: drop (the queue is in send order, so the aged frames are at the head).
    while (this.queue.length && now - this.queue[0]!.at > QUEUE_MAX_AGE_MS) {
      const old = this.queue.shift()!;
      this.queuedBytes -= old.frame.byteLength;
    }
    let budget = this.budget(now);
    while (this.queue.length && budget > 0) {
      const item = this.queue[0]!;
      try {
        ws.send(item.frame);
      } catch {
        this.dropped(); // the item stays queued for the next socket, unless its message was partly sent
        return;
      }
      this.queue.shift();
      this.queuedBytes -= item.frame.byteLength;
      this.sentTimes.push(now);
      budget--;
      this.lastSentGroup = item.group;
    }
    if (this.queue.length) {
      const wait = this.sentTimes[0]! + PACE_WINDOW_MS - now + 1;
      this.paceTimer = setTimeout(() => this.pump(), Math.max(1, wait));
    }
  }

  private ping(): void {
    const ws = this.ws;
    if (!this.isOpen || !ws || this.final || ws.readyState !== OPEN) return;
    const now = this.now();
    // Queued frames already count as activity for the relay; a ping must not eat their budget.
    if (this.queue.length || this.budget(now) <= 0) return;
    try {
      ws.send(new Uint8Array(0));
    } catch {
      this.dropped();
      return;
    }
    this.sentTimes.push(now);
  }
}
