/**
 * A panel's connection limit, for testing multiview locally (`FAKE_MAX_CONS`). Each live stream request is a session
 * per user. It counts while the player keeps reading its wrapper playlist (`livePlaylist`): a session nobody read for
 * `idleMs` stops counting, as a panel's cleanup job ends an HLS session late. At `max` open sessions the next open is
 * refused with 403 (`refuse`), or allowed while the oldest session is cut (`kick`): its next read answers 403.
 */
export type ConnectionsMode = 'refuse' | 'kick';

export interface ConnectionsOptions {
  max: number;
  mode: ConnectionsMode;
  /** A session nobody read for this long stops counting (default 20 s: two playlist reloads missed). */
  idleMs?: number;
}

export interface SessionTable {
  open(user: string): { ok: true; sid: string } | { ok: false };
  /** A read of the session: false when it is unknown, kicked or idle (answer 403). */
  touch(sid: string): boolean;
  stats(): { max: number; mode: ConnectionsMode; open: Record<string, number>; refused: number; kicked: number };
  reset(): void;
}

interface Session { user: string; openedAt: number; lastReadAt: number; kicked: boolean }

const DEFAULT_IDLE_MS = 20_000;

export function createSessionTable(opts: ConnectionsOptions, now: () => number): SessionTable {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const sessions = new Map<string, Session>();
  let seq = 0;
  let refused = 0;
  let kicked = 0;
  const alive = (s: Session, t: number) => !s.kicked && t - s.lastReadAt < idleMs;
  const prune = (t: number) => {
    for (const [sid, s] of sessions) if (!s.kicked && !alive(s, t)) sessions.delete(sid);
  };
  const liveOf = (user: string, t: number) => [...sessions.values()].filter((s) => s.user === user && alive(s, t));

  return {
    open(user) {
      const t = now();
      prune(t);
      const live = liveOf(user, t);
      if (live.length >= opts.max) {
        if (opts.mode === 'refuse') {
          refused++;
          return { ok: false };
        }
        const oldest = live.reduce((a, b) => (b.openedAt < a.openedAt ? b : a));
        oldest.kicked = true;
        kicked++;
      }
      const sid = `s${++seq}`;
      sessions.set(sid, { user, openedAt: t, lastReadAt: t, kicked: false });
      return { ok: true, sid };
    },
    touch(sid) {
      const t = now();
      const s = sessions.get(sid);
      if (!s || !alive(s, t)) return false;
      s.lastReadAt = t;
      return true;
    },
    stats() {
      const t = now();
      const open: Record<string, number> = {};
      for (const s of sessions.values()) if (alive(s, t)) open[s.user] = (open[s.user] ?? 0) + 1;
      return { max: opts.max, mode: opts.mode, open, refused, kicked };
    },
    reset() {
      sessions.clear();
      refused = 0;
      kicked = 0;
    },
  };
}

const SEGMENT_MS = 10_000;
/** Full 10 s segments of the shared test stream's 380p rendition (the last, shorter one is skipped). */
const SEGMENTS = 63;
const FIRST_SEGMENT = 718;
const WINDOW = 3;

/** A live media playlist for session `sid`: a 3-segment window that moves every 10 s, cycling the test segments. */
export function livePlaylist(sid: string, nowMs: number): string {
  const seq = Math.floor(nowMs / SEGMENT_MS);
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(seq / SEGMENTS)}`,
  ];
  for (let n = seq; n < seq + WINDOW; n++) {
    if (n > seq && n % SEGMENTS === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:10.000,', `/__mv/${sid}/${n}.ts`);
  }
  return lines.join('\n') + '\n';
}

/** Where segment `n` of a wrapper playlist lives: the licensed public test stream (same as `TEST_STREAM`). */
export function segmentLocation(n: number): string {
  return `https://test-streams.mux.dev/x36xhzz/url_${FIRST_SEGMENT + (n % SEGMENTS)}/193039199_mp4_h264_aac_7.ts`;
}
