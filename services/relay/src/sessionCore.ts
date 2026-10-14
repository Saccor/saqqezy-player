// Pure session logic for one relay session: peer roles, forwarding, reconnect queue, frame-size,
// rate, connect and byte limits, TTL and idle timeout. No I/O; the Durable Object wires the hooks
// to real sockets.
//
// Frames are opaque ciphertext. This class never inspects, logs or persists them. The only frame it
// treats specially is the empty one: a 0-byte binary frame is a heartbeat (ping). It counts as
// activity and against the rate limit, and is never forwarded or queued.

import { CLOSE, LIMITS, QueueBudget, isRole, type Limits, type Role } from './limits.ts';

export type { Role } from './limits.ts';

export interface SessionHooks {
  now(): number;
  /** Send a frame to the socket `conn` currently holding `role`. */
  send(role: Role, frame: Uint8Array, conn: number): void;
  /** Close the socket `conn` (which holds or held `role`). */
  close(role: Role, code: number, reason: string, conn: number): void;
}

export type ConnectResult =
  | { ok: true; conn: number }
  | { ok: false; code: number; reason: string };

interface Peer { role: Role; conn: number }
interface Queued { frame: Uint8Array; at: number }

const other = (r: Role): Role => (r === 'tv' ? 'phone' : 'tv');

/** Drop entries at or before `cutoff` from the front of a sorted timestamp list. */
function slide(list: number[], cutoff: number): void {
  let i = 0;
  while (i < list.length && (list[i] as number) <= cutoff) i++;
  if (i > 0) list.splice(0, i);
}

export class SessionCore {
  private readonly createdAt: number;
  private lastActivity: number;
  private nextConnId = 1;
  private pairedOnce = false;
  private forwardedBytes = 0;
  private readonly peers = new Map<Role, Peer>();
  private readonly byConn = new Map<number, Peer>();
  /** Frame times per role. Kept on the session, so replacing a socket does not reset the window. */
  private readonly rates = new Map<Role, number[]>([['tv', []], ['phone', []]]);
  private readonly connects: number[] = [];
  /** Frames waiting for a role that is away, keyed by destination role. */
  private readonly queues = new Map<Role, { items: Queued[]; bytes: number }>([
    ['tv', { items: [], bytes: 0 }],
    ['phone', { items: [], bytes: 0 }],
  ]);
  private ended_: { code: number; reason: string } | null = null;

  /**
   * @param budget Reconnect-queue bytes shared by every session in the isolate. The Durable Object
   *   passes one module-level instance; the default is private to this session (tests).
   */
  constructor(
    private readonly hooks: SessionHooks,
    private readonly limits: Limits = LIMITS,
    private readonly budget: QueueBudget = new QueueBudget(limits.isolateQueueMaxBytes, limits.queueMaxAgeMs),
  ) {
    this.createdAt = hooks.now();
    this.lastActivity = this.createdAt;
  }

  get ended(): boolean { return this.ended_ !== null; }

  /** True while at least one socket is attached. */
  get hasPeers(): boolean { return this.peers.size > 0; }

  /** The conn id the next successful `connect()` will return. */
  get nextConn(): number { return this.nextConnId; }

  /** Bytes currently held in the reconnect queues. */
  get queuedBytes(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.bytes;
    return n;
  }

  connect(role: string): ConnectResult {
    if (!isRole(role)) return { ok: false, code: CLOSE.BAD_ROLE, reason: 'bad role' };
    const now = this.hooks.now();
    this.tick(now);
    if (this.ended_ !== null) return { ok: false, ...this.ended_ };

    slide(this.connects, now - this.limits.connectWindowMs);
    if (this.connects.length >= this.limits.maxConnectsPerWindow) {
      return { ok: false, code: CLOSE.RATE_LIMIT, reason: 'too many connects' };
    }
    this.connects.push(now);

    const old = this.peers.get(role);
    if (old) {
      this.detach(old);
      this.hooks.close(role, CLOSE.REPLACED, 'replaced', old.conn);
    }
    const peer: Peer = { role, conn: this.nextConnId++ };
    this.peers.set(role, peer);
    this.byConn.set(peer.conn, peer);
    if (this.peers.size === 2) this.pairedOnce = true;
    // Connects are not activity: only frames (pings included) keep a session alive.

    const q = this.queues.get(role)!;
    const items = q.items;
    q.items = []; q.bytes = 0;
    for (const item of items) {
      this.budget.release(item.frame.byteLength, item.at);
      this.hooks.send(role, item.frame, peer.conn);
    }
    return { ok: true, conn: peer.conn };
  }

  frame(conn: number, data: Uint8Array): void {
    const peer = this.byConn.get(conn);
    if (!peer) return; // replaced, closed, or unknown socket
    const now = this.hooks.now();
    this.tick(now);
    if (this.ended_ !== null) return;

    if (data.byteLength > this.limits.maxFrameBytes) {
      this.kick(peer, CLOSE.TOO_LARGE, 'frame too large');
      return;
    }
    const rate = this.rates.get(peer.role)!;
    slide(rate, now - this.limits.rateWindowMs);
    if (rate.length >= this.limits.maxFramesPerWindow) {
      this.kick(peer, CLOSE.RATE_LIMIT, 'rate limit');
      return;
    }
    rate.push(now);
    this.lastActivity = now;
    if (data.byteLength === 0) return; // heartbeat

    this.forwardedBytes += data.byteLength;
    if (this.forwardedBytes > this.limits.sessionMaxBytes) {
      this.end(CLOSE.RATE_LIMIT, 'quota');
      return;
    }

    const dest = other(peer.role);
    const target = this.peers.get(dest);
    if (target) this.hooks.send(dest, data, target.conn);
    else this.enqueue(dest, data, now);
  }

  /** The socket `conn` went away (closed by the client or the network). */
  disconnect(conn: number): void {
    const peer = this.byConn.get(conn);
    if (peer) this.detach(peer);
  }

  /** Enforce TTL, idle timeout and queue age. Call periodically and before handling events. */
  tick(now: number): void {
    if (this.ended_ !== null) return;
    const ttl = this.pairedOnce ? this.limits.sessionTtlMaxMs : this.limits.sessionTtlUnpairedMs;
    if (now - this.createdAt >= ttl) { this.end(CLOSE.EXPIRED, 'expired'); return; }
    if (now - this.lastActivity >= this.limits.idleTimeoutMs) { this.end(CLOSE.EXPIRED, 'idle'); return; }
    const cutoff = now - this.limits.queueMaxAgeMs;
    for (const q of this.queues.values()) {
      while (q.items.length > 0 && (q.items[0] as Queued).at < cutoff) this.dropOldest(q);
    }
  }

  private enqueue(dest: Role, data: Uint8Array, now: number): void {
    // The isolate-wide budget is exhausted: drop the frame rather than queue it.
    if (!this.budget.reserve(data.byteLength, now)) return;
    const q = this.queues.get(dest)!;
    q.items.push({ frame: data, at: now });
    q.bytes += data.byteLength;
    while (q.bytes > this.limits.queueMaxBytes && q.items.length > 0) this.dropOldest(q);
  }

  private dropOldest(q: { items: Queued[]; bytes: number }): void {
    const item = q.items.shift() as Queued;
    q.bytes -= item.frame.byteLength;
    this.budget.release(item.frame.byteLength, item.at);
  }

  private detach(peer: Peer): void {
    this.byConn.delete(peer.conn);
    if (this.peers.get(peer.role) === peer) this.peers.delete(peer.role);
  }

  private kick(peer: Peer, code: number, reason: string): void {
    this.detach(peer);
    this.hooks.close(peer.role, code, reason, peer.conn);
  }

  private end(code: number, reason: string): void {
    this.ended_ = { code, reason };
    for (const q of this.queues.values()) while (q.items.length > 0) this.dropOldest(q);
    for (const role of ['tv', 'phone'] as const) {
      const peer = this.peers.get(role);
      if (peer) this.kick(peer, code, reason);
    }
  }
}
