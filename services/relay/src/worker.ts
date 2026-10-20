// Cloudflare Worker + Durable Object relay. It forwards opaque encrypted frames between one TV
// socket and one phone socket per session, and stores nothing.
//
// Privacy (CLAUDE.md guardrails 6 and 7):
// - No Durable Object storage reads or writes.
// - No logging at all: not frame contents, not session ids, not IPs.
// - The connecting IP is never held: the in-memory new-session limit is keyed by HMAC(IPv4 address
//   or IPv6 /64, per-isolate random key); the shared limit (Cloudflare Rate Limiting binding) is
//   keyed by a truncated SHA-256 of the same prefix, held only in Cloudflare's counter.
//
// Sockets use the standard `accept()` API, not WebSocket Hibernation: hibernation would evict the
// in-memory SessionCore (creation time, reconnect queue, rate windows), and enforcing TTL while
// hibernated needs storage-backed alarms. Sessions are capped at 60 minutes (15 if never paired),
// so the cost of keeping the object resident while sockets are open is bounded.

import { DurableObject } from 'cloudflare:workers';
import { SessionCore } from './sessionCore.ts';
import {
  CLOSE, IpRateLimiter, LIMITS, QueueBudget, RecentSessions, allowNewSession, isRole, isSessionId, limitsFromEnv,
  originAllowed, parseAllowedOrigins, type LimitsEnv, type RateLimitBinding,
} from './limits.ts';

export interface Env extends LimitsEnv {
  SESSION: DurableObjectNamespace<Session>;
  ALLOWED_ORIGINS: string;
  /**
   * Cloudflare Workers Rate Limiting binding (`[[ratelimits]]` in wrangler.toml): the new-session
   * limit shared across isolates. Optional: without it the per-isolate in-memory limit applies.
   */
  NEW_SESSION_LIMITER?: RateLimitBinding;
}

const ROUTE = /^\/v1\/session\/([^/]+)\/ws$/;
const TICK_MS = 1000;

// Per-isolate, in memory only: the first line. The NEW_SESSION_LIMITER binding enforces the same
// limit across isolates when it is configured.
const newSessionLimiter = new IpRateLimiter(LIMITS.newSessionsPerIp, LIMITS.newSessionWindowMs);
const recentSessions = new RecentSessions(LIMITS.sessionTtlMaxMs);
/** Reconnect-queue bytes across every session in this isolate (all Session objects share it). */
const queuedBytesTotal = new QueueBudget(LIMITS.isolateQueueMaxBytes, LIMITS.queueMaxAgeMs);

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Accept the upgrade and close immediately with an application close code. */
function acceptAndClose(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return text(200, 'ok');

    const m = ROUTE.exec(url.pathname);
    const sessionId = m?.[1];
    if (!sessionId || !isSessionId(sessionId)) return text(404, 'not found');
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return text(426, 'websocket upgrade required');
    }

    const role = url.searchParams.get('role');
    const origin = request.headers.get('Origin');
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    if (!isRole(role)) {
      // A bad role from a missing, `null` or unlisted Origin is refused before the upgrade.
      if (origin === null || !allowed.has(origin)) return text(403, 'forbidden');
      return acceptAndClose(CLOSE.BAD_ROLE, 'bad role');
    }
    if (!originAllowed(origin, role, allowed)) return text(403, 'forbidden');

    // Only a session id this isolate has not seen counts as a new session; joins and reconnects
    // to a known id are free. The limiter only ever sees an HMAC of the address prefix.
    if (!recentSessions.has(sessionId, Date.now())) {
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      const now = Date.now();
      if (!(await allowNewSession(ip, now, newSessionLimiter, env.NEW_SESSION_LIMITER))) {
        return text(429, 'too many sessions');
      }
      recentSessions.add(sessionId, now);
    }

    const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** One Durable Object per session id. In-memory only. */
export class Session extends DurableObject<Env> {
  private core: SessionCore | null = null;
  private readonly sockets = new Map<number, WebSocket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The socket being attached during `core.connect()`, before it is in `sockets`. */
  private attaching: WebSocket | null = null;
  /** The conn id `attaching` will get if the connect succeeds. */
  private pendingConn = 0;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text(426, 'websocket upgrade required');
    const role = new URL(request.url).searchParams.get('role') ?? '';

    const core = this.core ??= new SessionCore({
      now: () => Date.now(),
      send: (_role, frame, conn) => {
        const ws = this.sockets.get(conn) ?? (conn === this.pendingConn ? this.attaching : null);
        try { ws?.send(frame); } catch { /* socket already gone */ }
      },
      close: (_role, code, reason, conn) => {
        const ws = this.sockets.get(conn);
        this.sockets.delete(conn);
        try { ws?.close(code, reason); } catch { /* already closed */ }
        this.maybeStopTimer();
      },
    }, limitsFromEnv(this.env), queuedBytesTotal);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Recent compatibility dates default to Blob for binary messages; frames must be ArrayBuffers.
    server.binaryType = 'arraybuffer';
    server.accept();

    // connect() may deliver queued frames to the new socket before its conn id is returned.
    this.attaching = server;
    this.pendingConn = core.nextConn;
    const result = core.connect(role);
    this.attaching = null;
    this.pendingConn = 0;
    if (!result.ok) {
      server.close(result.code, result.reason);
      return new Response(null, { status: 101, webSocket: client });
    }
    const conn = result.conn;
    this.sockets.set(conn, server);

    server.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data;
      if (!(data instanceof ArrayBuffer)) {
        // Frames are binary ciphertext only.
        core.disconnect(conn);
        this.sockets.delete(conn);
        try { server.close(1003, 'binary frames only'); } catch { /* already closed */ }
        this.maybeStopTimer();
        return;
      }
      core.frame(conn, new Uint8Array(data));
    });
    const gone = (): void => {
      core.disconnect(conn);
      this.sockets.delete(conn);
      // Complete the closing handshake from our side; harmless if it is already closed.
      try { server.close(1000, 'bye'); } catch { /* already closed */ }
      this.maybeStopTimer();
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);

    this.timer ??= setInterval(() => {
      core.tick(Date.now());
      this.maybeStopTimer();
    }, TICK_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Stop ticking once no socket is attached and nothing is queued (queued frames still age out). */
  private maybeStopTimer(): void {
    if (this.timer !== null && this.sockets.size === 0 && (this.core?.queuedBytes ?? 0) === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
