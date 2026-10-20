import { describe, expect, test, vi } from 'vitest';
import {
  IpRateLimiter, LIMITS, allowNewSession, sharedLimitKey, type RateLimitBinding,
} from '../src/limits.ts';

const SEC = 1000;

function binding(success: boolean): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: vi.fn(async ({ key }: { key: string }) => { keys.push(key); return { success }; }),
  };
}
const localLimiter = (): IpRateLimiter => new IpRateLimiter(LIMITS.newSessionsPerIp, LIMITS.newSessionWindowMs);

describe('shared (cross-isolate) new-session key', () => {
  test('is stable hex, equal within an IPv6 /64, different across /64s and IPv4 addresses', async () => {
    const a = await sharedLimitKey('2001:db8:1:2:aaaa::1');
    const b = await sharedLimitKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee');
    const c = await sharedLimitKey('2001:db8:1:3::1');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await sharedLimitKey('192.0.2.7')).toBe(await sharedLimitKey('::ffff:192.0.2.7'));
    expect(await sharedLimitKey('192.0.2.7')).not.toBe(await sharedLimitKey('192.0.2.8'));
  });

  test('never contains the raw address', async () => {
    expect(await sharedLimitKey('192.0.2.7')).not.toContain('192');
  });
});

describe('allowNewSession', () => {
  test('the binding is keyed by the /64 prefix: every address in one /64 shares a counter', async () => {
    const rl = binding(true);
    const local = localLimiter();
    expect(await allowNewSession('2001:db8:1:2::1', 0, local, rl)).toBe(true);
    expect(await allowNewSession('2001:db8:1:2:ffff:ffff:ffff:ffff', SEC, local, rl)).toBe(true);
    expect(rl.keys).toHaveLength(2);
    expect(rl.keys[0]).toBe(rl.keys[1]);
    expect(rl.keys[0]).toBe(await sharedLimitKey('2001:db8:1:2::1'));
  });

  test('binding says no: refused even though the in-memory limit has room', async () => {
    const rl = binding(false);
    expect(await allowNewSession('192.0.2.7', 0, localLimiter(), rl)).toBe(false);
    expect(rl.limit).toHaveBeenCalledTimes(1);
  });

  test('in-memory limit is the first line: once it refuses, the binding is not asked', async () => {
    const rl = binding(true);
    const local = localLimiter();
    for (let i = 0; i < LIMITS.newSessionsPerIp; i++) expect(await allowNewSession('192.0.2.7', i, local, rl)).toBe(true);
    expect(await allowNewSession('192.0.2.7', 30 * SEC, local, rl)).toBe(false);
    expect(rl.limit).toHaveBeenCalledTimes(LIMITS.newSessionsPerIp);
  });

  test('in-memory limit counts an IPv6 /64 as one client', async () => {
    const local = localLimiter();
    for (let i = 0; i < LIMITS.newSessionsPerIp; i++) {
      expect(await allowNewSession(`2001:db8:9:9:${i.toString(16)}::1`, i, local, undefined)).toBe(true);
    }
    expect(await allowNewSession('2001:db8:9:9:abcd::2', 30 * SEC, local, undefined)).toBe(false);
    expect(await allowNewSession('2001:db8:9:a::1', 30 * SEC, local, undefined)).toBe(true);
  });

  test('binding absent (dev, tests): falls back to the in-memory limit', async () => {
    const local = localLimiter();
    for (let i = 0; i < LIMITS.newSessionsPerIp; i++) expect(await allowNewSession('192.0.2.7', i, local, undefined)).toBe(true);
    expect(await allowNewSession('192.0.2.7', 30 * SEC, local, undefined)).toBe(false);
    expect(await allowNewSession('192.0.2.8', 30 * SEC, local, undefined)).toBe(true);
  });

  test('binding error: falls back to the in-memory decision instead of blocking everyone', async () => {
    const broken: RateLimitBinding = { limit: async () => { throw new Error('unavailable'); } };
    expect(await allowNewSession('192.0.2.7', 0, localLimiter(), broken)).toBe(true);
  });
});
