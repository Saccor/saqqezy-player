// Relay limits and small pure helpers. See Plan 4 Global Constraints and spec §5.
// Privacy: nothing here logs anything. Raw IPs are never held: the per-IP limiter is keyed by an
// HMAC of the address prefix under a per-isolate random key, in memory only.

export const LIMITS = {
  /** Max size of one frame on the wire. */
  maxFrameBytes: 300 * 1024,
  /** Max frames per role per rate window (pings included). */
  maxFramesPerWindow: 200,
  rateWindowMs: 10_000,
  /** Max socket connects per session per connect window. */
  maxConnectsPerWindow: 30,
  connectWindowMs: 60_000,
  /** Max bytes forwarded (sent or queued) over a session's lifetime. */
  sessionMaxBytes: 64 * 1024 * 1024,
  /** A session that has never had both peers connected ends this long after creation. */
  sessionTtlUnpairedMs: 15 * 60_000,
  /** Once both peers have been connected at least once, the hard cap from creation. */
  sessionTtlMaxMs: 60 * 60_000,
  /** A session ends after this long without frames (pings count; connects do not). */
  idleTimeoutMs: 5 * 60_000,
  /** Reconnect queue, per destination role. */
  queueMaxBytes: 2 * 1024 * 1024,
  queueMaxAgeMs: 60_000,
  /** Reconnect-queue bytes across all sessions in one isolate. */
  isolateQueueMaxBytes: 32 * 1024 * 1024,
  /** New sessions per IP (IPv4 address or IPv6 /64) per window (per isolate, in memory only). */
  newSessionsPerIp: 10,
  newSessionWindowMs: 60_000,
} as const;

export type Limits = { readonly [K in keyof typeof LIMITS]: number };

export const CLOSE = {
  EXPIRED: 4000,
  REPLACED: 4001,
  TOO_LARGE: 4002,
  RATE_LIMIT: 4003,
  BAD_ROLE: 4004,
} as const;

export type Role = 'tv' | 'phone';

export function isRole(x: unknown): x is Role {
  return x === 'tv' || x === 'phone';
}

/** Timer overrides that only `wrangler dev` sets (top-level `[vars]`); production uses LIMITS. */
export interface LimitsEnv {
  RELAY_TTL_UNPAIRED_MS?: string;
  RELAY_TTL_MAX_MS?: string;
  RELAY_IDLE_MS?: string;
}

export function limitsFromEnv(env: LimitsEnv): Limits {
  const ms = (v: string | undefined, fallback: number): number => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  return {
    ...LIMITS,
    sessionTtlUnpairedMs: ms(env.RELAY_TTL_UNPAIRED_MS, LIMITS.sessionTtlUnpairedMs),
    sessionTtlMaxMs: ms(env.RELAY_TTL_MAX_MS, LIMITS.sessionTtlMaxMs),
    idleTimeoutMs: ms(env.RELAY_IDLE_MS, LIMITS.idleTimeoutMs),
  };
}

/**
 * A session id is 16 bytes as canonical base64url: 22 characters, no padding, and the last
 * character carries only 2 significant bits (the 4 trailing bits must be zero).
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
export function isSessionId(s: string): boolean {
  return SESSION_ID_RE.test(s);
}

export function parseAllowedOrigins(csv: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (csv ?? '').split(',')) {
    const o = part.trim();
    if (o) out.add(o);
  }
  return out;
}

/**
 * Origin rules: a listed origin is allowed for both roles. A packaged TV app may send
 * `Origin: null` or `file://`, or no Origin at all; those are allowed only for `role=tv`.
 * This is hygiene, not a security control: non-browser clients can send any Origin.
 */
export function originAllowed(origin: string | null, role: Role, allowed: ReadonlySet<string>): boolean {
  if (origin === null || origin === 'null' || origin.startsWith('file://')) return role === 'tv';
  return allowed.has(origin);
}

/**
 * The part of an address the per-IP limit counts by: the full IPv4 address (IPv4-mapped IPv6
 * included), or the /64 prefix of an IPv6 address, since one host usually holds a whole /64.
 */
export function ipPrefix(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s === '') return 'none';
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return `v4:${s}`;
  const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return `v4:${mapped[1]}`;

  const halves = s.split('::');
  if (halves.length > 2) return `v6:${s}`;
  const parse = (part: string | undefined): string[] => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  // An embedded dotted IPv4 tail counts as two groups.
  const groupsIn = (xs: string[]): number => xs.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const groups = halves.length === 2
    ? [...head, ...new Array<string>(Math.max(0, 8 - groupsIn(head) - groupsIn(tail))).fill('0'), ...tail]
    : head;
  const prefix = groups.slice(0, 4).map((g) => {
    const n = parseInt(g, 16);
    return /^[0-9a-f]{1,4}$/.test(g) && Number.isFinite(n) ? n.toString(16) : g;
  });
  return `v6:${prefix.join(':')}`;
}

// One random HMAC key per isolate. Workers do not allow random generation at global scope, so it
// is created on first use (once per isolate) and never leaves memory.
let ipKey: Promise<CryptoKey> | null = null;

/** The limiter key for an IP: hex of HMAC-SHA256(prefix) truncated to 16 bytes. No raw IP is kept. */
export async function ipLimitKey(ip: string): Promise<string> {
  ipKey ??= crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']) as Promise<CryptoKey>;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await ipKey, new TextEncoder().encode(ipPrefix(ip))));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += (mac[i] as number).toString(16).padStart(2, '0');
  return hex;
}

/**
 * Sliding-window counter per key, in memory only. Keys are kept in last-hit order (a hit moves the
 * key to the end), so stale keys sit at the front: every check prunes at most `prunePerCall` of
 * them, which is O(1) amortised. Memory is bounded by `maxKeys`: when full, the least recently
 * hit key is dropped.
 */
export class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly prunePerCall = 8,
  ) {}

  get size(): number { return this.hits.size; }

  allow(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    this.pruneSome(cutoff);
    let list = this.hits.get(key);
    if (list) {
      while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
      if (list.length >= this.max) return false;
      this.hits.delete(key);
    } else {
      list = [];
      while (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next();
        if (oldest.done) break;
        this.hits.delete(oldest.value);
      }
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  private pruneSome(cutoff: number): void {
    let n = 0;
    for (const [k, list] of this.hits) {
      if (n >= this.prunePerCall) break;
      const last = list[list.length - 1];
      if (last !== undefined && last > cutoff) break;
      this.hits.delete(k);
      n++;
    }
  }
}

/**
 * Bytes queued for absent peers across every session in this isolate. Reservations are grouped
 * into one-second buckets and expire on their own after `maxAgeMs`, the reconnect queue's max age:
 * no queued frame lives longer than that, so a session that disappears without releasing cannot
 * leak budget. Pruning walks expired buckets from the front, which is O(1) amortised.
 */
export class QueueBudget {
  private readonly buckets = new Map<number, number>();
  private total = 0;

  constructor(private readonly maxBytes: number, private readonly maxAgeMs: number, private readonly bucketMs = 1000) {}

  used(now: number): number {
    this.expire(now);
    return this.total;
  }

  /** Reserve `n` bytes for a frame queued at `at`. False (and nothing reserved) when over budget. */
  reserve(n: number, at: number): boolean {
    this.expire(at);
    if (this.total + n > this.maxBytes) return false;
    const b = Math.floor(at / this.bucketMs);
    this.buckets.set(b, (this.buckets.get(b) ?? 0) + n);
    this.total += n;
    return true;
  }

  /** Release a reservation made at `at` (no-op if it already expired). */
  release(n: number, at: number): void {
    const b = Math.floor(at / this.bucketMs);
    const cur = this.buckets.get(b);
    if (cur === undefined) return;
    const take = Math.min(cur, n);
    this.total -= take;
    if (cur - take === 0) this.buckets.delete(b);
    else this.buckets.set(b, cur - take);
  }

  private expire(now: number): void {
    // A bucket expires once every frame in it is older than maxAgeMs.
    const cutoff = now - this.maxAgeMs;
    for (const [b, bytes] of this.buckets) {
      if ((b + 1) * this.bucketMs > cutoff) break;
      this.total -= bytes;
      this.buckets.delete(b);
    }
  }
}

/**
 * Session ids this isolate has routed recently (within the session hard cap), in memory only. A
 * connection to a known id is a join or reconnect, not a new session, so it does not count against
 * the per-IP new-session limit. Never stored alongside IPs. Bounded by `maxKeys`.
 */
export class RecentSessions {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number, private readonly maxKeys = 50_000) {}

  get size(): number { return this.seen.size; }

  has(id: string, now: number): boolean {
    const at = this.seen.get(id);
    if (at === undefined) return false;
    if (now - at >= this.ttlMs) { this.seen.delete(id); return false; }
    return true;
  }

  add(id: string, now: number): void {
    if (this.seen.has(id)) return; // keep the first-seen time: the TTL runs from creation
    if (this.seen.size >= this.maxKeys) {
      for (const [k, at] of this.seen) if (now - at >= this.ttlMs) this.seen.delete(k);
      for (const k of this.seen.keys()) {
        if (this.seen.size < this.maxKeys) break;
        this.seen.delete(k);
      }
    }
    this.seen.set(id, now);
  }
}
