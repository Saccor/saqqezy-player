import { beforeEach, describe, expect, test } from 'vitest';
import { SessionCore, type Role } from '../src/sessionCore.ts';
import { CLOSE, LIMITS, IpRateLimiter, RecentSessions, isSessionId, originAllowed, parseAllowedOrigins } from '../src/limits.ts';

const SEC = 1000;
const MIN = 60 * SEC;

interface Sent { role: Role; conn: number; bytes: number[] }
interface Closed { role: Role; conn: number; code: number; reason: string }

let t = 0;
let sent: Sent[] = [];
let closed: Closed[] = [];
let core: SessionCore;

function frame(...bytes: number[]): Uint8Array { return Uint8Array.from(bytes); }
function sized(n: number): Uint8Array { return new Uint8Array(n); }
function connect(role: string): number {
  const r = core.connect(role);
  if (!r.ok) throw new Error(`connect rejected ${r.code}`);
  return r.conn;
}

beforeEach(() => {
  t = 0; sent = []; closed = [];
  core = new SessionCore({
    now: () => t,
    send: (role, f, conn) => { sent.push({ role, conn, bytes: [...f] }); },
    close: (role, code, reason, conn) => { closed.push({ role, conn, code, reason }); },
  });
});

describe('SessionCore forwarding', () => {
  test('forwards frames unchanged in both directions', () => {
    const tv = connect('tv');
    const phone = connect('phone');
    core.frame(tv, frame(1, 2, 3));
    core.frame(phone, frame(9));
    expect(sent).toEqual([
      { role: 'phone', conn: phone, bytes: [1, 2, 3] },
      { role: 'tv', conn: tv, bytes: [9] },
    ]);
    expect(closed).toEqual([]);
  });

  test('a new socket of the same role replaces the old one with 4001', () => {
    const tv1 = connect('tv');
    const phone = connect('phone');
    const tv2 = connect('tv');
    expect(closed).toEqual([{ role: 'tv', conn: tv1, code: CLOSE.REPLACED, reason: 'replaced' }]);
    core.frame(tv1, frame(1)); // stale socket: ignored
    core.frame(phone, frame(2));
    core.frame(tv2, frame(3));
    expect(sent).toEqual([
      { role: 'tv', conn: tv2, bytes: [2] },
      { role: 'phone', conn: phone, bytes: [3] },
    ]);
  });

  test('rejects an unknown role with 4004', () => {
    expect(core.connect('admin')).toEqual({ ok: false, code: CLOSE.BAD_ROLE, reason: 'bad role' });
  });

  test('a disconnect of a replaced socket does not affect the new one', () => {
    const tv1 = connect('tv');
    const tv2 = connect('tv');
    const phone = connect('phone');
    core.disconnect(tv1);
    core.frame(phone, frame(5));
    expect(sent).toEqual([{ role: 'tv', conn: tv2, bytes: [5] }]);
  });
});

describe('SessionCore reconnect queue', () => {
  test('queues while the peer is away and delivers on reconnect within 60 s', () => {
    const tv = connect('tv');
    const phone = connect('phone');
    core.disconnect(phone);
    core.frame(tv, frame(1));
    t += 30 * SEC;
    core.frame(tv, frame(2));
    expect(sent).toEqual([]);
    t += 29 * SEC;
    core.tick(t);
    const phone2 = connect('phone');
    expect(sent).toEqual([
      { role: 'phone', conn: phone2, bytes: [1] },
      { role: 'phone', conn: phone2, bytes: [2] },
    ]);
  });

  test('drops queued frames older than 60 s', () => {
    const tv = connect('tv');
    core.frame(tv, frame(1));
    t += 40 * SEC;
    core.frame(tv, frame(2));
    t += 21 * SEC; // frame 1 is now 61 s old, frame 2 is 21 s old
    core.tick(t);
    const phone = connect('phone');
    expect(sent).toEqual([{ role: 'phone', conn: phone, bytes: [2] }]);
  });

  test('drops everything older than 60 s even without a tick', () => {
    const tv = connect('tv');
    core.frame(tv, frame(1));
    t += 60 * SEC + 1;
    const phone = connect('phone');
    expect(sent.filter((s) => s.conn === phone)).toEqual([]);
  });

  test('keeps the queue within 2 MiB by dropping the oldest frames', () => {
    const tv = connect('tv');
    for (let i = 0; i < 8; i++) {
      const f = sized(LIMITS.maxFrameBytes);
      f[0] = i;
      core.frame(tv, f);
    }
    const phone = connect('phone');
    const got = sent.filter((s) => s.conn === phone).map((s) => s.bytes[0]);
    expect(got).toEqual([2, 3, 4, 5, 6, 7]); // 6 x 300 KiB fits in 2 MiB, 7 does not
  });
});

describe('SessionCore limits', () => {
  test('a frame of exactly 300 KiB is forwarded', () => {
    const tv = connect('tv');
    connect('phone');
    core.frame(tv, sized(300 * 1024));
    expect(sent).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  test('an oversized frame closes the sender with 4002 and is not forwarded', () => {
    const tv = connect('tv');
    connect('phone');
    core.frame(tv, sized(300 * 1024 + 1));
    expect(sent).toEqual([]);
    expect(closed).toEqual([{ role: 'tv', conn: tv, code: CLOSE.TOO_LARGE, reason: 'frame too large' }]);
    core.frame(tv, frame(1)); // closed socket: ignored
    expect(sent).toEqual([]);
  });

  test('more than 200 frames in 10 s closes the sender with 4003', () => {
    const tv = connect('tv');
    connect('phone');
    for (let i = 0; i < 200; i++) { core.frame(tv, frame(i & 0xff)); t += 10; }
    expect(sent).toHaveLength(200);
    expect(closed).toEqual([]);
    core.frame(tv, frame(0));
    expect(sent).toHaveLength(200);
    expect(closed).toEqual([{ role: 'tv', conn: tv, code: CLOSE.RATE_LIMIT, reason: 'rate limit' }]);
  });

  test('the rate window slides: 200 frames every 10 s is fine', () => {
    const tv = connect('tv');
    connect('phone');
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 200; i++) core.frame(tv, frame(1));
      t += 10 * SEC;
    }
    expect(sent).toHaveLength(600);
    expect(closed).toEqual([]);
  });

  test('the rate limit is per socket', () => {
    const tv = connect('tv');
    const phone = connect('phone');
    for (let i = 0; i < 200; i++) { core.frame(tv, frame(1)); core.frame(phone, frame(2)); }
    expect(closed).toEqual([]);
  });
});

describe('SessionCore lifetime', () => {
  test('the session expires 15 minutes after creation, even with traffic', () => {
    const tv = connect('tv');
    const phone = connect('phone');
    for (let m = 1; m < 15; m++) { t = m * MIN; core.frame(tv, frame(m)); core.tick(t); }
    t = 15 * MIN - 1;
    core.tick(t);
    expect(closed).toEqual([]);
    t = 15 * MIN;
    core.tick(t);
    expect(closed).toEqual([
      { role: 'tv', conn: tv, code: CLOSE.EXPIRED, reason: 'expired' },
      { role: 'phone', conn: phone, code: CLOSE.EXPIRED, reason: 'expired' },
    ]);
    expect(core.ended).toBe(true);
    expect(core.connect('tv')).toEqual({ ok: false, code: CLOSE.EXPIRED, reason: 'expired' });
  });

  test('the session ends after 5 minutes without frames', () => {
    const tv = connect('tv');
    const phone = connect('phone');
    t = 4 * MIN;
    core.frame(phone, frame(1)); // activity resets the idle timer
    t = 9 * MIN - 1;
    core.tick(t);
    expect(closed).toEqual([]);
    t = 9 * MIN;
    core.tick(t);
    expect(closed).toEqual([
      { role: 'tv', conn: tv, code: CLOSE.EXPIRED, reason: 'idle' },
      { role: 'phone', conn: phone, code: CLOSE.EXPIRED, reason: 'idle' },
    ]);
    expect(core.ended).toBe(true);
  });

  test('a frame arriving at the idle deadline ends the session instead of forwarding', () => {
    const tv = connect('tv');
    connect('phone');
    t = 5 * MIN;
    core.frame(tv, frame(1));
    expect(sent).toEqual([]);
    expect(core.ended).toBe(true);
  });
});

describe('relay helpers', () => {
  test('session ids are canonical base64url of 16 bytes', () => {
    expect(isSessionId('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(isSessionId('abcdefghijklmnopqrst-w')).toBe(true);
    expect(isSessionId('abcdefghijklmnopqrst_B')).toBe(false); // non-zero trailing bits
    expect(isSessionId('AAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(isSessionId('AAAAAAAAAAAAAAAAAAAAAA==')).toBe(false);
    expect(isSessionId('AAAAAAAAAAAAAAAAAAAA+A')).toBe(false);
  });

  test('origins: listed origins allowed; null, file:// and missing only for tv', () => {
    const allowed = parseAllowedOrigins(' http://localhost:5174 ,http://localhost:5173,');
    expect(allowed).toEqual(new Set(['http://localhost:5174', 'http://localhost:5173']));
    expect(originAllowed('http://localhost:5174', 'phone', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', 'tv', allowed)).toBe(true);
    expect(originAllowed('https://other.example.test', 'phone', allowed)).toBe(false);
    expect(originAllowed('null', 'tv', allowed)).toBe(true);
    expect(originAllowed('file://', 'tv', allowed)).toBe(true);
    expect(originAllowed(null, 'tv', allowed)).toBe(true);
    expect(originAllowed('null', 'phone', allowed)).toBe(false);
    expect(originAllowed('file://', 'phone', allowed)).toBe(false);
    expect(originAllowed(null, 'phone', allowed)).toBe(false);
  });

  test('per-key limiter allows 10 per minute, then refuses until the window passes', () => {
    const lim = new IpRateLimiter(LIMITS.newSessionsPerIp, LIMITS.newSessionWindowMs);
    for (let i = 0; i < 10; i++) expect(lim.allow('k', i * SEC)).toBe(true);
    expect(lim.allow('k', 30 * SEC)).toBe(false);
    expect(lim.allow('other', 30 * SEC)).toBe(true);
    expect(lim.allow('k', 60 * SEC)).toBe(true); // the first entry (t=0) has aged out
  });

  test('the limiter memory is bounded', () => {
    const lim = new IpRateLimiter(10, MIN, 100);
    for (let i = 0; i < 1000; i++) lim.allow(`k${i}`, 0);
    expect(lim.size).toBeLessThanOrEqual(100);
  });

  test('recent sessions: joining or reconnecting to a known session is not a new session', () => {
    const recent = new RecentSessions(LIMITS.sessionTtlMs, 3);
    expect(recent.has('a', 0)).toBe(false);
    recent.add('a', 0);
    expect(recent.has('a', 14 * MIN)).toBe(true);
    expect(recent.has('a', 15 * MIN)).toBe(false); // past the session TTL
    for (const k of ['b', 'c', 'd', 'e']) recent.add(k, 15 * MIN);
    expect(recent.size).toBeLessThanOrEqual(3);
    expect(recent.has('e', 15 * MIN)).toBe(true);
  });
});
