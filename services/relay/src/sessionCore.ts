// Pure session logic for one relay session: peer roles, forwarding, reconnect queue, frame-size and
// rate limits, TTL and idle timeout. No I/O; the Durable Object wires the hooks to real sockets.
//
// Frames are opaque ciphertext. This class never inspects, logs or persists them.

import { CLOSE, LIMITS, isRole, type Limits, type Role } from './limits.ts';

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

interface Peer { role: Role; conn: number; rate: number[] }
interface Queued { frame: Uint8Array; at: number }

const other = (r: Role): Role => (r === 'tv' ? 'phone' : 'tv');

export class SessionCore {
  private readonly createdAt: number;
  private lastActivity: number;
  private nextConn = 1;
  private readonly peers = new Map<Role, Peer>();
  private readonly byConn = new Map<number, Peer>();
  /** Frames waiting for a role that is away, keyed by destination role. */
  private readonly queues = new Map<Role, { items: Queued[]; bytes: number }>([
    ['tv', { items: [], bytes: 0 }],
    ['phone', { items: [], bytes: 0 }],
  ]);
  private endedReason: string | null = null;

  constructor(private readonly hooks: SessionHooks, private readonly limits: Limits = LIMITS) {
    this.createdAt = hooks.now();
    this.lastActivity = this.createdAt;
  }

  get ended(): boolean { return this.endedReason !== null; }

  /** True while at least one socket is attached. */
  get hasPeers(): boolean { return this.peers.size > 0; }

  connect(role: string): ConnectResult {
    if (!isRole(role)) return { ok: false, code: CLOSE.BAD_ROLE, reason: 'bad role' };
    this.tick(this.hooks.now());
    if (this.endedReason !== null) return { ok: false, code: CLOSE.EXPIRED, reason: this.endedReason };

    const old = this.peers.get(role);
    if (old) {
      this.detach(old);
      this.hooks.close(role, CLOSE.REPLACED, 'replaced', old.conn);
    }
    const peer: Peer = { role, conn: this.nextConn++, rate: [] };
    this.peers.set(role, peer);
    this.byConn.set(peer.conn, peer);
    this.lastActivity = this.hooks.now();

    const q = this.queues.get(role)!;
    const items = q.items;
    q.items = []; q.bytes = 0;
    for (const item of items) this.hooks.send(role, item.frame, peer.conn);
    return { ok: true, conn: peer.conn };
  }

  frame(conn: number, data: Uint8Array): void {
    const peer = this.byConn.get(conn);
    if (!peer) return; // replaced, closed, or unknown socket
    const now = this.hooks.now();
    this.tick(now);
    if (this.endedReason !== null) return;

    if (data.byteLength > this.limits.maxFrameBytes) {
      this.kick(peer, CLOSE.TOO_LARGE, 'frame too large');
      return;
    }
    const cutoff = now - this.limits.rateWindowMs;
    while (peer.rate.length > 0 && (peer.rate[0] as number) <= cutoff) peer.rate.shift();
    if (peer.rate.length >= this.limits.maxFramesPerWindow) {
      this.kick(peer, CLOSE.RATE_LIMIT, 'rate limit');
      return;
    }
    peer.rate.push(now);
    this.lastActivity = now;

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
    if (this.endedReason !== null) return;
    if (now - this.createdAt >= this.limits.sessionTtlMs) { this.end('expired'); return; }
    if (now - this.lastActivity >= this.limits.idleTimeoutMs) { this.end('idle'); return; }
    const cutoff = now - this.limits.queueMaxAgeMs;
    for (const q of this.queues.values()) {
      while (q.items.length > 0 && (q.items[0] as Queued).at < cutoff) {
        q.bytes -= (q.items.shift() as Queued).frame.byteLength;
      }
    }
  }

  private enqueue(dest: Role, data: Uint8Array, now: number): void {
    const q = this.queues.get(dest)!;
    q.items.push({ frame: data, at: now });
    q.bytes += data.byteLength;
    while (q.bytes > this.limits.queueMaxBytes && q.items.length > 0) {
      q.bytes -= (q.items.shift() as Queued).frame.byteLength;
    }
  }

  private detach(peer: Peer): void {
    this.byConn.delete(peer.conn);
    if (this.peers.get(peer.role) === peer) this.peers.delete(peer.role);
  }

  private kick(peer: Peer, code: number, reason: string): void {
    this.detach(peer);
    this.hooks.close(peer.role, code, reason, peer.conn);
  }

  private end(reason: string): void {
    this.endedReason = reason;
    for (const q of this.queues.values()) { q.items = []; q.bytes = 0; }
    for (const role of ['tv', 'phone'] as const) {
      const peer = this.peers.get(role);
      if (peer) this.kick(peer, CLOSE.EXPIRED, reason);
    }
  }
}
