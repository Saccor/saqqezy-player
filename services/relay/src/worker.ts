// Cloudflare Worker + Durable Object relay. It forwards opaque encrypted frames between one TV
// socket and one phone socket per session, and stores nothing.
//
// Privacy (CLAUDE.md guardrails 6 and 7):
// - No Durable Object storage reads or writes.
// - No logging at all: not frame contents, not session ids, not IPs.
// - The connecting IP is used only as an in-memory key for the new-session limit.
//
// Sockets use the standard `accept()` API, not WebSocket Hibernation: hibernation would evict the
// in-memory SessionCore (creation time, reconnect queue, rate windows), and enforcing TTL while
// hibernated needs storage-backed alarms. Sessions are capped at 15 minutes, so the cost of
// keeping the object resident while sockets are open is bounded.

import { DurableObject } from 'cloudflare:workers';
import { SessionCore } from './sessionCore.ts';
import { CLOSE, IpRateLimiter, LIMITS, RecentSessions, isRole, isSessionId, originAllowed, parseAllowedOrigins } from './limits.ts';

export interface Env {
  SESSION: DurableObjectNamespace<Session>;
  ALLOWED_ORIGINS: string;
}

const ROUTE = /^\/v1\/session\/([^/]+)\/ws$/;
const TICK_MS = 1000;

// Per-isolate, in memory only. Approximate across isolates by design: no shared store holds IPs.
const newSessionLimiter = new IpRateLimiter(LIMITS.newSessionsPerIp, LIMITS.newSessionWindowMs);
const recentSessions = new RecentSessions(LIMITS.sessionTtlMs);

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
      if (origin === null || !allowed.has(origin)) return text(403, 'forbidden');
      return acceptAndClose(CLOSE.BAD_ROLE, 'bad role');
    }
    if (!originAllowed(origin, role, allowed)) return text(403, 'forbidden');

    // Only a session id this isolate has not seen counts as a new session; joins and reconnects
    // to a known id are free. The IP is a transient in-memory key and is never logged or stored.
    const now = Date.now();
    if (!recentSessions.has(sessionId, now)) {
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      if (!newSessionLimiter.allow(ip, now)) return text(429, 'too many sessions');
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
  /** The socket being attached during `core.connect()`, before its conn id is known. */
  private attaching: WebSocket | null = null;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text(426, 'websocket upgrade required');
    const role = new URL(request.url).searchParams.get('role') ?? '';

    const core = this.core ??= new SessionCore({
      now: () => Date.now(),
      send: (_role, frame, conn) => {
        try { (this.sockets.get(conn) ?? this.attaching)?.send(frame); } catch { /* socket already gone */ }
      },
      close: (_role, code, reason, conn) => {
        const ws = this.sockets.get(conn);
        this.sockets.delete(conn);
        try { ws?.close(code, reason); } catch { /* already closed */ }
        this.maybeStopTimer();
      },
    });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Recent compatibility dates default to Blob for binary messages; frames must be ArrayBuffers.
    server.binaryType = 'arraybuffer';
    server.accept();

    // connect() may deliver queued frames to the new socket before its conn id is returned.
    this.attaching = server;
    const result = core.connect(role);
    this.attaching = null;
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

  private maybeStopTimer(): void {
    if (this.timer !== null && this.sockets.size === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
