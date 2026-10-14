import { beforeEach, describe, expect, test } from 'vitest';
import { SessionCore, type Role } from '../src/sessionCore.ts';
import {
  CLOSE, LIMITS, IpRateLimiter, QueueBudget, RecentSessions, ipLimitKey, ipPrefix, isSessionId, limitsFromEnv,
  originAllowed, parseAllowedOrigins,
} from '../src/limits.ts';

const SEC = 1000;
const MIN = 60 * SEC;

interface Sent { role: Role; conn: number; bytes: number[] }
interface Closed { role: Role; conn: number; code: number; reason: string }

let t = 0;
let sent: Sent[] = [];
let closed: Closed[] = [];
let budget: QueueBudget;
let core: SessionCore;

function frame(...bytes: number[]): Uint8Array { return Uint8Array.from(bytes); }
function sized(n: number): Uint8Array { return new Uint8Array(n); }
const ping = (): Uint8Array => new Uint8Array(0);
function connect(role: string, c: SessionCore = core): number {
  const r = c.connect(role);
  if (!r.ok) throw new Error(`connect rejected ${r.code}`);
  return r.conn;
}
function newCore(): SessionCore {
  return new SessionCore({
    now: () => t,
    send: (role, f, conn) => { sent.push({ role, conn, bytes: [...f] }); },
    close: (role, code, reason, conn) => { closed.push({ role, conn, code, reason }); },
  }, LIMITS, budget);
}

beforeEach(() => {
  t = 0; sent = []; closed = [];
  budget = new QueueBudget(LIMITS.isolateQueueMaxBytes, LIMITS.queueMaxAgeMs);
  core = newCore();
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

  test('nextConn is the conn id the next successful connect returns', () => {
    const expected = core.nextConn;
    expect(connect('tv')).toBe(expected);
    expect(core.nextConn).toBe(expected + 1);
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

  test('a ping for an absent peer is not queued', () => {
    const tv = connect('tv');
    core.frame(tv, ping());
    const phone = connect('phone');
    expect(sent.filter((s) => s.conn === phone)).toEqual([]);
    expect(core.queuedBytes).toBe(0);
  });
});

describe('isolate-wide queue budget', () => {
  test('frames for absent peers are dropped once the isolate budget is exhausted', () => {
    budget = new QueueBudget(1000, LIMITS.queueMaxAgeMs);
    const a = newCore();
    const b = newCore();
    const ta = connect('tv', a);
    const tb = connect('tv', b);
    a.frame(ta, sized(600));
    b.frame(tb, sized(600)); // would take the isolate past 1000 bytes: dropped, not queued
    expect(budget.used(t)).toBe(600);
    expect(b.queuedBytes).toBe(0);
    connect('phone', b);
    expect(sent).toHaveLength(0);
    connect('phone', a);
    expect(sent).toHaveLength(1);
    expect(budget.used(t)).toBe(0); // delivered frames release their bytes
  });

  test('queue age-out and session end release the budget', () => {
    const tv = connect('tv');
    core.frame(tv, sized(1000));
    expect(budget.used(t)).toBe(1000);
    t += 61 * SEC;
    core.tick(t);
    expect(budget.used(t)).toBe(0);
    core.frame(tv, sized(500));
    expect(budget.used(t)).toBe(500);
    t += 5 * MIN; // idle
    core.tick(t);
    expect(core.ended).toBe(true);
    expect(budget.used(t)).toBe(0);
  });

  test('reservations expire on their own after the queue max age, so a vanished session cannot leak', () => {
    const b = new QueueBudget(1000, 60 * SEC);
    expect(b.reserve(800, 0)).toBe(true);
    expect(b.reserve(300, 30 * SEC)).toBe(false);
    expect(b.used(62 * SEC)).toBe(0);
    expect(b.reserve(900, 62 * SEC)).toBe(true);
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

  test('the rate limit is per role', () => {
    const tv = connect('tv');
    const phone = connect('phone');
    for (let i = 0; i < 200; i++) { core.frame(tv, frame(1)); core.frame(phone, frame(2)); }
    expect(closed).toEqual([]);
  });

  test('the rate window carries over when a socket is replaced', () => {
    const tv1 = connect('tv');
    connect('phone');
    for (let i = 0; i < 150; i++) core.frame(tv1, frame(1));
    const tv2 = connect('tv');
    for (let i = 0; i < 50; i++) core.frame(tv2, frame(1));
    expect(closed.filter((c) => c.code === CLOSE.RATE_LIMIT)).toEqual([]);
    core.frame(tv2, frame(1));
    expect(closed).toContainEqual({ role: 'tv', conn: tv2, code: CLOSE.RATE_LIMIT, reason: 'rate limit' });
  });

  test('pings count against the rate limit', () => {
    const tv = connect('tv');
    for (let i = 0; i < 200; i++) core.frame(tv, ping());
    expect(closed).toEqual([]);
    core.frame(tv, ping());
    expect(closed).toEqual([{ role: 'tv', conn: tv, code: CLOSE.RATE_LIMIT, reason: 'rate limit' }]);
  });

  test('more than 30 connects per minute per session is refused with 4003', () => {
    for (let i = 0; i < 30; i++) { connect(i % 2 ? 'phone' : 'tv'); t += SEC; }
    expect(core.connect('tv')).toEqual({ ok: false, code: CLOSE.RATE_LIMIT, reason: 'too many connects' });
    t = 61 * SEC; // the first two connects (t=0, t=1 s) have aged out
    expect(core.connect('tv').ok).toBe(true);
    expect(core.ended).toBe(false);
  });

  test('more than 64 MiB forwarded in one session closes both sockets with 4003', () => {
    expect(LIMITS.sessionMaxBytes).toBe(64 * 1024 * 1024);
    // Scaled down (1 KiB budget) so the spy does not copy 64 MiB; the logic is identical.
    core = new SessionCore({
      now: () => t,
      send: (role, f, conn) => { sent.push({ role, conn, bytes: [f.byteLength] }); },
      close: (role, code, reason, conn) => { closed.push({ role, conn, code, reason }); },
    }, { ...LIMITS, sessionMaxBytes: 1024 }, budget);
    const tv = connect('tv');
    const phone = connect('phone');
    for (let i = 0; i < 4; i++) core.frame(tv, sized(256)); // exactly the budget
    expect(closed).toEqual([]);
    expect(sent).toHaveLength(4);
    core.frame(phone, frame(1));
    expect(sent).toHaveLength(4);
    expect(closed).toEqual([
      { role: 'tv', conn: tv, code: CLOSE.RATE_LIMIT, reason: 'quota' },
      { role: 'phone', conn: phone, code: CLOSE.RATE_LIMIT, reason: 'quota' },
    ]);
    expect(core.ended).toBe(true);
    expect(core.connect('tv')).toEqual({ ok: false, code: CLOSE.RATE_LIMIT, reason: 'quota' });
  });
});

describe('SessionCore lifetime', () => {
  test('a session that never had both peers expires 15 minutes after creation, even with pings', () => {
    const tv = connect('tv');
    for (let i = 1; i < 30; i++) { t = i * 30 * SEC; core.frame(tv, ping()); }
    t = 15 * MIN - 1;
    core.tick(t);
    expect(closed).toEqual([]);
    t = 15 * MIN;
    core.tick(t);
    expect(closed).toEqual([{ role: 'tv', conn: tv, code: CLOSE.EXPIRED, reason: 'expired' }]);
    expect(core.ended).toBe(true);
    expect(core.connect('tv')).toEqual({ ok: false, code: CLOSE.EXPIRED, reason: 'expired' });
  });

  test('once both peers have been connected, the hard cap is 60 minutes from creation', () => {
    const tv = connect('tv');
    let phone2 = 0;
    for (let m = 1; m < 60; m++) {
      t = m * MIN;
      if (m === 14) core.disconnect(connect('phone')); // having been paired once is enough
      if (m === 30) phone2 = connect('phone');
      core.frame(tv, frame(m));
      core.tick(t);
    }
    t = 60 * MIN - 1;
    core.tick(t);
    expect(closed).toEqual([]);
    t = 60 * MIN;
    core.tick(t);
    expect(closed).toEqual([
      { role: 'tv', conn: tv, code: CLOSE.EXPIRED, reason: 'expired' },
      { role: 'phone', conn: phone2, code: CLOSE.EXPIRED, reason: 'expired' },
    ]);
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

  test('a ping is not forwarded but counts as activity', () => {
    const tv = connect('tv');
    connect('phone');
    t = 4 * MIN;
    core.frame(tv, ping());
    expect(sent).toEqual([]);
    t = 9 * MIN - 1;
    core.tick(t);
    expect(core.ended).toBe(false);
    t = 9 * MIN;
    core.tick(t);
    expect(core.ended).toBe(true);
  });

  test('connects do not count as activity', () => {
    connect('tv');
    t = 3 * MIN;
    connect('phone');
    t = 5 * MIN;
    core.tick(t);
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

  test('the limiter prunes a bounded number of stale keys on every check', () => {
    const lim = new IpRateLimiter(10, MIN, 10_000, 8);
    for (let i = 0; i < 100; i++) lim.allow(`k${i}`, i);
    expect(lim.size).toBe(100);
    lim.allow('fresh', 2 * MIN);
    expect(lim.size).toBe(100 - 8 + 1);
    for (let i = 0; i < 20; i++) lim.allow('fresh', 2 * MIN);
    expect(lim.size).toBe(1);
  });

  test('the limiter keeps keys in last-hit order, so fresh keys never block pruning wrongly', () => {
    const lim = new IpRateLimiter(10, MIN, 10_000, 8);
    lim.allow('a', 0);
    lim.allow('b', 30 * SEC);
    lim.allow('a', 50 * SEC); // a moves behind b
    lim.allow('c', 85 * SEC); // b (last hit 30 s) is still fresh at 85 s
    expect(lim.size).toBe(3);
    lim.allow('c', 91 * SEC); // b is stale now; a (50 s) is still fresh
    expect(lim.size).toBe(2);
  });

  test('IP prefixes: IPv4 by full address, IPv6 by /64', () => {
    expect(ipPrefix('192.0.2.7')).toBe('v4:192.0.2.7');
    expect(ipPrefix('::ffff:192.0.2.7')).toBe('v4:192.0.2.7');
    expect(ipPrefix('2001:db8:1:2:3:4:5:6')).toBe('v6:2001:db8:1:2');
    expect(ipPrefix('2001:0DB8:0001:0002::9')).toBe('v6:2001:db8:1:2');
    expect(ipPrefix('2001:db8::1')).toBe('v6:2001:db8:0:0');
    expect(ipPrefix('::1')).toBe('v6:0:0:0:0');
    expect(ipPrefix('fe80::1%eth0')).toBe('v6:fe80:0:0:0');
    expect(ipPrefix('')).toBe('none');
  });

  test('IP keys are HMAC-SHA256 truncated to 16 bytes hex, equal within a /64', async () => {
    const a = await ipLimitKey('2001:db8:1:2:aaaa::1');
    const b = await ipLimitKey('2001:db8:1:2:bbbb::2');
    const c = await ipLimitKey('2001:db8:1:3::1');
    const v4 = await ipLimitKey('192.0.2.7');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await ipLimitKey('192.0.2.7')).toBe(v4);
    expect(await ipLimitKey('192.0.2.8')).not.toBe(v4);
  });

  test('limitsFromEnv: dev overrides for the timers, production values by default', () => {
    expect(limitsFromEnv({})).toEqual(LIMITS);
    const l = limitsFromEnv({ RELAY_TTL_UNPAIRED_MS: '60000', RELAY_TTL_MAX_MS: 'x', RELAY_IDLE_MS: '-5' });
    expect(l.sessionTtlUnpairedMs).toBe(60_000);
    expect(l.sessionTtlMaxMs).toBe(LIMITS.sessionTtlMaxMs);
    expect(l.idleTimeoutMs).toBe(LIMITS.idleTimeoutMs);
  });

  test('recent sessions: joining or reconnecting to a known session is not a new session', () => {
    const recent = new RecentSessions(LIMITS.sessionTtlMaxMs, 3);
    expect(recent.has('a', 0)).toBe(false);
    recent.add('a', 0);
    expect(recent.has('a', 59 * MIN)).toBe(true);
    expect(recent.has('a', 60 * MIN)).toBe(false); // past the session hard cap
    for (const k of ['b', 'c', 'd', 'e']) recent.add(k, 60 * MIN);
    expect(recent.size).toBeLessThanOrEqual(3);
    expect(recent.has('e', 60 * MIN)).toBe(true);
  });
});
