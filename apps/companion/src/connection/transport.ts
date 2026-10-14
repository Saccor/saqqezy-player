import {
  QueueFullError, WebSocketRelayTransport, type RelayTransport, type WebSocketFactory, type WebSocketLike,
} from '@iptv/companion-protocol';

/**
 * The companion's one long-lived relay transport. It wraps `WebSocketRelayTransport` (which owns the close-code
 * policy, backoff, pacing, queueing and heartbeats) and adds what a phone browser needs on top:
 *
 * - `resume()`: reconnect right now instead of waiting for the backoff, used when the page becomes visible again.
 * - A relay that stays unreachable while the page is hidden (a phone in a pocket) does not end the session: the
 *   attempt is parked and resumed when the page is visible again. While parked, sends are refused with the
 *   non-final QueueFullError. Any other final close (expired, replaced, limits) still ends the session.
 * - `onOpen`: every socket that opened, so the client knows the link is up (and when to start its welcome timer).
 *
 * The SecureChannel sees one transport for the whole session, so its msgId counter and replay window carry
 * over every reconnect. Never logs anything: the URL contains the session id.
 */
export class CompanionTransport implements RelayTransport {
  private inner: WebSocketRelayTransport | null = null;
  private innerUnsub: (() => void)[] = [];
  private final = false;
  /** True from a `resume()` until that inner transport's first socket opened: that open is a reconnect. */
  private resuming = false;

  private readonly frameListeners = new Set<(f: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly reconnectedListeners = new Set<() => void>();
  private readonly disconnectedListeners = new Set<() => void>();
  private readonly openListeners = new Set<() => void>();

  constructor(
    private readonly opts: {
      url: string;
      WebSocket: WebSocketFactory;
      /** Absolute session end (ms since epoch): the transport gives up then. */
      deadline: number;
      isHidden: () => boolean;
      now?: () => number;
    },
  ) {
    this.spawn();
  }

  send(frame: Uint8Array, messageId?: number): void {
    if (this.final) throw new Error('transport closed');
    if (!this.inner) throw new QueueFullError(); // parked while hidden: message-scoped, the session stays
    // The message id lets the inner transport drop the rest of a message it already partly sent (no half-sent messages).
    this.inner.send(frame, messageId);
  }

  fits(frameBytes: readonly number[]): boolean {
    return !this.final && this.inner !== null && this.inner.fits(frameBytes);
  }

  onFrame(fn: (f: Uint8Array) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  onClose(fn: (reason: string) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  onReconnected(fn: () => void): () => void {
    this.reconnectedListeners.add(fn);
    return () => this.reconnectedListeners.delete(fn);
  }

  onDisconnected(fn: () => void): () => void {
    this.disconnectedListeners.add(fn);
    return () => this.disconnectedListeners.delete(fn);
  }

  /** Every socket that opened (the first one and each reconnect). */
  onOpen(fn: () => void): () => void {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  /** True while parked (unreachable while hidden). */
  get parked(): boolean {
    return !this.final && this.inner === null;
  }

  /**
   * Reconnects now with a fresh socket (skipping any backoff wait), or wakes a parked transport. Frames still
   * queued in the old socket's queue are dropped; the caller re-requests what it needs after `onReconnected`.
   */
  resume(): void {
    if (this.final) return;
    if (this.now() >= this.opts.deadline) {
      this.giveUp('deadline');
      return;
    }
    this.resuming = true;
    this.spawn();
  }

  close(): void {
    if (this.final) return;
    this.final = true;
    this.dropInner();
    this.clearListeners();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private spawn(): void {
    this.dropInner();
    // Each inner transport gets its own WebSocket subclass, so an `open` is attributed to the right one.
    let inner: WebSocketRelayTransport | null = null;
    const notifyOpen = (ws: WebSocketLike) => {
      if (this.final || inner === null || this.inner !== inner || ws.readyState !== 1) return;
      this.fire(this.openListeners);
      if (this.resuming) {
        this.resuming = false;
        this.fire(this.reconnectedListeners);
      }
    };
    const Base = this.opts.WebSocket;
    const Tracked = class extends (Base as unknown as new (url: string) => WebSocketLike & EventTarget) {
      constructor(url: string) {
        super(url);
        this.addEventListener('open', () => queueMicrotask(() => notifyOpen(this)));
      }
    };
    inner = new WebSocketRelayTransport({
      url: this.opts.url,
      WebSocket: Tracked as unknown as WebSocketFactory,
      deadline: this.opts.deadline,
    });
    this.inner = inner;
    const self = inner;
    this.innerUnsub = [
      inner.onFrame((f) => {
        for (const fn of [...this.frameListeners]) fn(f);
      }),
      inner.onReconnected(() => {
        if (this.inner === self) this.fire(this.reconnectedListeners);
      }),
      inner.onDisconnected(() => {
        if (this.inner === self) this.fire(this.disconnectedListeners);
      }),
      inner.onClose((reason) => {
        if (this.inner !== self) return;
        if (reason === 'unreachable' && this.opts.isHidden() && this.now() < this.opts.deadline) {
          // Park until the page is visible again.
          this.dropInner();
          this.resuming = false;
          this.fire(this.disconnectedListeners);
          return;
        }
        this.giveUp(reason);
      }),
    ];
  }

  private dropInner(): void {
    for (const u of this.innerUnsub) u();
    this.innerUnsub = [];
    const old = this.inner;
    this.inner = null;
    old?.close();
  }

  private giveUp(reason: string): void {
    if (this.final) return;
    this.final = true;
    this.dropInner();
    for (const fn of [...this.closeListeners]) {
      try {
        fn(reason);
      } catch {
        // Ignore listener errors.
      }
    }
    this.clearListeners();
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

  private clearListeners(): void {
    this.frameListeners.clear();
    this.closeListeners.clear();
    this.reconnectedListeners.clear();
    this.disconnectedListeners.clear();
    this.openListeners.clear();
  }
}
