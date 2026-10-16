import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SourceRefusedError } from '../src/errors.ts';
import { RefusalGuard, type SourceCooldown } from '../src/net/refusalGuard.ts';
import type { FetchFn } from '../src/types.ts';

const MIN = 60_000;
let t: number;
let storage: MemoryStorage;
let timers: { at: number; fn: () => void; id: number }[];
let nextId: number;
const timer = {
  set: (fn: () => void, ms: number) => { const id = ++nextId; timers.push({ at: t + ms, fn, id }); return id; },
  clear: (id: unknown) => { timers = timers.filter((x) => x.id !== id); },
};
/** Moves the clock and fires due timers. */
const advance = (ms: number) => {
  t += ms;
  const due = timers.filter((x) => x.at <= t);
  timers = timers.filter((x) => x.at > t);
  for (const x of due) x.fn();
};
const make = () => new RefusalGuard({ storage, now: () => t, timer });

beforeEach(() => {
  t = 1_000_000;
  storage = new MemoryStorage();
  timers = [];
  nextId = 0;
});

describe('RefusalGuard ladder', () => {
  test('starts clear', async () => {
    expect(await make().status('s')).toEqual({ state: 'clear' });
  });

  test('2 min, then 10 min, then manual only', async () => {
    const g = make();
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
    advance(2 * MIN);
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
    advance(10 * MIN);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'manual', reason: 'refused' });
    advance(24 * 60 * MIN);
    expect(g.isBlocked('s')).toBe(true);
  });

  test('a refusal while already blocked does not move up the ladder', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.report('s', 'refused');
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
  });

  test('an answer clears the record, so the ladder restarts at 2 min', async () => {
    const g = make();
    await g.report('s', 'refused');
    advance(2 * MIN);
    await g.report('s', 'answered');
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
  });

  test('keys are independent', async () => {
    const g = make();
    await g.report('a', 'refused');
    expect(g.isBlocked('a')).toBe(true);
    expect(g.isBlocked('b')).toBe(false);
  });
});

describe('RefusalGuard persistence, retry and listeners', () => {
  test('a new instance on the same storage keeps waiting', async () => {
    await make().report('s', 'refused');
    advance(30_000);
    const g = make();
    expect(g.isBlocked('s')).toBe(false); // not loaded yet: sync reads know nothing
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t - 30_000 + 2 * MIN, reason: 'refused' });
    expect(g.isBlocked('s')).toBe(true);
  });

  test('manual only survives a restart', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN, 0]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    expect(await make().status('s')).toEqual({ state: 'manual', reason: 'refused' });
  });

  test('retry unblocks one attempt and keeps the step', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.retry('s');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
  });

  test('a refused retry from manual stays manual', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN, 0]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    await g.retry('s');
    expect(g.isBlocked('s')).toBe(false);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'manual', reason: 'refused' });
  });

  test('forget drops the record and its storage', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.forget('s');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    expect(await make().status('s')).toEqual({ state: 'clear' });
  });

  test('listeners hear every change, including the end of a wait', async () => {
    const g = make();
    const seen: [string, SourceCooldown, string][] = [];
    g.onChange((key, c, cause) => seen.push([key, c, cause]));
    const until = t + 2 * MIN;
    await g.report('s', 'refused');
    advance(2 * MIN);
    await g.report('s', 'answered'); // already clear for the UI: still announced once the record is gone
    expect(seen).toEqual([
      ['s', { state: 'waiting', until, reason: 'refused' }, 'refused'],
      ['s', { state: 'clear' }, 'expired'],
      ['s', { state: 'clear' }, 'answered'],
    ]);
    await g.report('s', 'answered'); // nothing stored: no event
    expect(seen).toHaveLength(3);
  });

  test('a wait loaded from storage still ends with an event', async () => {
    await make().report('s', 'refused');
    timers = [];
    const g = make();
    const seen: [SourceCooldown, string][] = [];
    g.onChange((_k, c, cause) => seen.push([c, cause]));
    await g.status('s');
    advance(2 * MIN);
    expect(seen).toEqual([[{ state: 'clear' }, 'expired']]);
  });

  test('an answer that lands while blocked does not clear the block', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.report('s', 'answered');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
  });

  test('a timer that fires early (the clock went back) waits again instead of announcing', async () => {
    const g = make();
    const seen: string[] = [];
    g.onChange((_k, _c, cause) => seen.push(cause));
    await g.report('s', 'refused');
    const first = timers[0]!;
    timers = [];
    t -= 30_000; // the wall clock moved back
    first.fn();
    expect(seen).toEqual(['refused']);
    expect(timers).toHaveLength(1);
    advance(2 * MIN + 30_000);
    expect(seen).toEqual(['refused', 'expired']);
  });

  test('retry and forget announce their cause', async () => {
    const g = make();
    const seen: string[] = [];
    g.onChange((_k, _c, cause) => seen.push(cause));
    await g.report('s', 'refused');
    await g.retry('s');
    await g.forget('s');
    expect(seen).toEqual(['refused', 'retry', 'forget']);
  });
});

describe('RefusalGuard.wrap', () => {
  let calls: string[];
  let answer: () => Promise<Response>;
  const base: FetchFn = async (url) => { calls.push(url); return answer(); };
  beforeEach(() => {
    calls = [];
    answer = async () => new Response('ok');
  });

  test('passes answers through and records refusals', async () => {
    const g = make();
    const f = g.wrap('s', base);
    answer = async () => new Response('no', { status: 403 });
    const res = await f('http://x.test/a');
    expect(res.status).toBe(403);
    expect(g.isBlocked('s')).toBe(true);
  });

  test.each([401, 403, 429, 458, 503, 509])('%i is a refusal', async (status) => {
    const g = make();
    answer = async () => new Response('', { status });
    await g.wrap('s', base)('http://x.test/a');
    expect(g.isBlocked('s')).toBe(true);
  });

  test.each([404, 500, 502])('%i is not a refusal', async (status) => {
    const g = make();
    answer = async () => new Response('', { status });
    await g.wrap('s', base)('http://x.test/a');
    expect(g.isBlocked('s')).toBe(false);
  });

  test('sends nothing while blocked, including after a reload', async () => {
    await make().report('s', 'refused');
    const f = make().wrap('s', base);
    await expect(f('http://x.test/a')).rejects.toBeInstanceOf(SourceRefusedError);
    expect(calls).toEqual([]);
  });

  test('after a wait only one probe is in flight', async () => {
    const g = make();
    await g.report('s', 'refused');
    advance(2 * MIN);
    let release!: (r: Response) => void;
    answer = () => new Promise((r) => { release = r; });
    const f = g.wrap('s', base);
    const probe = f('http://x.test/1');
    await new Promise((r) => setTimeout(r, 0));
    await expect(f('http://x.test/2')).rejects.toBeInstanceOf(SourceRefusedError);
    release(new Response('ok'));
    await probe;
    answer = async () => new Response('ok');
    await f('http://x.test/3');
    expect(calls).toEqual(['http://x.test/1', 'http://x.test/3']);
  });

  test('a network error frees the probe and changes nothing', async () => {
    const g = make();
    await g.report('s', 'refused');
    advance(2 * MIN);
    answer = async () => { throw new TypeError('down'); };
    const f = g.wrap('s', base);
    await expect(f('http://x.test/1')).rejects.toBeInstanceOf(TypeError);
    answer = async () => new Response('', { status: 403 });
    await f('http://x.test/2');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
  });

  test('requests in flight when the first refusal lands count once', async () => {
    const g = make();
    const f = g.wrap('s', base);
    answer = async () => new Response('', { status: 403 });
    await Promise.all([f('http://x.test/1'), f('http://x.test/2'), f('http://x.test/3')]);
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
  });
});

describe('RefusalGuard Retry-After', () => {
  test('replaces the step wait, clamped to 30 s ... 60 min; the step still increments', async () => {
    const g = make();
    await g.report('s', 'refused', { retryAfterMs: 5 * MIN });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 5 * MIN, reason: 'refused' });
    advance(5 * MIN);
    await g.report('s', 'refused', { retryAfterMs: 1_000 });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30_000, reason: 'refused' });
    advance(30_000);
    await g.report('s', 'refused', { retryAfterMs: 5 * 60 * MIN });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 60 * MIN, reason: 'refused' });
  });

  test('the next refusal without a header continues the ladder', async () => {
    const g = make();
    await g.report('s', 'refused', { retryAfterMs: 1 * MIN });
    advance(1 * MIN);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
  });

  test('on the manual step it still waits, then allows one probe', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    await g.report('s', 'refused', { retryAfterMs: 3 * MIN });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 3 * MIN, reason: 'refused' });
    advance(3 * MIN);
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'manual', reason: 'refused' });
  });

  test('wrap reads the header of a refusal', async () => {
    const g = make();
    const f = g.wrap('s', async () => new Response('', { status: 429, headers: { 'Retry-After': '300' } }));
    await f('http://x.test/a');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 5 * MIN, reason: 'refused' });
  });
});

describe('RefusalGuard unreachable breaker', () => {
  const unreachable = (until: number): SourceCooldown => ({ state: 'waiting', until, reason: 'unreachable' });
  const fail3 = async (g: RefusalGuard, key = 's') => {
    for (let i = 0; i < 3; i++) await g.report(key, 'failed');
  };

  test('trips on the 3rd failure in a row within 5 min', async () => {
    const g = make();
    await g.report('s', 'failed');
    advance(2 * MIN);
    await g.report('s', 'failed');
    expect(g.isBlocked('s')).toBe(false);
    advance(2 * MIN);
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN));
  });

  test('3 failures spread over 6 min do not trip it', async () => {
    const g = make();
    await g.report('s', 'failed');
    advance(3 * MIN);
    await g.report('s', 'failed');
    advance(3 * MIN);
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual({ state: 'clear' });
  });

  test('an answer resets the run', async () => {
    const g = make();
    await g.report('s', 'failed');
    await g.report('s', 'failed');
    await g.report('s', 'answered');
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual({ state: 'clear' });
  });

  test('ladder 1, 5, 15, 15 min: a failed probe after the wait moves one step up', async () => {
    const g = make();
    await fail3(g);
    expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN));
    for (const [wait, next] of [[1, 5], [5, 15], [15, 15]] as const) {
      advance(wait * MIN);
      expect(await g.status('s')).toEqual({ state: 'clear' });
      await g.report('s', 'failed');
      expect(await g.status('s')).toEqual(unreachable(t + next * MIN));
    }
  });

  test('failures that land while blocked do not count', async () => {
    const g = make();
    await fail3(g);
    await fail3(g);
    expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN));
  });

  test('an answer clears it and announces', async () => {
    const g = make();
    const seen: string[] = [];
    g.onChange((_k, _c, cause) => seen.push(cause));
    await fail3(g);
    advance(1 * MIN);
    await g.report('s', 'answered');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await fail3(g);
    expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN)); // the ladder restarted
    expect(seen).toEqual(['unreachable', 'expired', 'answered', 'unreachable']);
  });

  test('a refusal while unreachable replaces it with the refusal ladder', async () => {
    const g = make();
    await fail3(g);
    advance(1 * MIN);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
    expect(await storage.getMeta('unreachable:s')).toBeNull();
    advance(2 * MIN);
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual({ state: 'clear' }); // the run starts over
  });

  test('retry lets one probe through and keeps the step', async () => {
    const g = make();
    await fail3(g);
    await g.retry('s');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual(unreachable(t + 5 * MIN));
  });

  test('persists as unreachable:{key} and survives a reload', async () => {
    await fail3(make());
    expect(await storage.getMeta('unreachable:s')).toMatchObject({ step: 1, until: t + 1 * MIN });
    const g = make();
    expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN));
    advance(1 * MIN);
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual(unreachable(t + 5 * MIN));
  });

  test('the run before a trip survives a reload', async () => {
    await make().report('s', 'failed');
    await make().report('s', 'failed');
    const g = make();
    await g.report('s', 'failed');
    expect(g.isBlocked('s')).toBe(true);
  });

  test('forget drops it', async () => {
    const g = make();
    await fail3(g);
    await g.forget('s');
    expect(await make().status('s')).toEqual({ state: 'clear' });
    expect(await storage.getMeta('unreachable:s')).toBeNull();
  });

  describe('through wrap', () => {
    test.each([500, 502, 504])('%i counts as a failure', async (status) => {
      const g = make();
      const f = g.wrap('s', async () => new Response('', { status }));
      for (let i = 0; i < 3; i++) await f('http://x.test/a');
      expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN));
    });

    test('404 is an answer', async () => {
      const g = make();
      await g.report('s', 'failed');
      await g.report('s', 'failed');
      await g.wrap('s', async () => new Response('', { status: 404 }))('http://x.test/a');
      await g.report('s', 'failed');
      expect(g.isBlocked('s')).toBe(false);
    });

    test('a network error or timeout counts and is rethrown', async () => {
      const g = make();
      const f = g.wrap('s', async () => { throw new TypeError('down'); });
      for (let i = 0; i < 3; i++) await expect(f('http://x.test/a')).rejects.toBeInstanceOf(TypeError);
      expect(g.isBlocked('s')).toBe(true);
      await expect(f('http://x.test/a')).rejects.toBeInstanceOf(SourceRefusedError);
    });

    test('a user cancel does not count', async () => {
      const g = make();
      const ctl = new AbortController();
      ctl.abort();
      const f = g.wrap('s', async () => { throw new DOMException('aborted', 'AbortError'); });
      for (let i = 0; i < 3; i++) {
        await expect(f('http://x.test/a', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
      }
      expect(g.isBlocked('s')).toBe(false);
    });

    test("an abort that is not the caller's counts", async () => {
      const g = make();
      const f = g.wrap('s', async () => { throw new DOMException('aborted', 'AbortError'); });
      for (let i = 0; i < 3; i++) await expect(f('http://x.test/a')).rejects.toMatchObject({ name: 'AbortError' });
      expect(g.isBlocked('s')).toBe(true);
    });

    test('after the wait only one probe is in flight', async () => {
      const g = make();
      await fail3(g);
      advance(1 * MIN);
      let release!: (r: Response) => void;
      const calls: string[] = [];
      const f = g.wrap('s', (url) => { calls.push(url); return new Promise((r) => { release = r; }); });
      const probe = f('http://x.test/1');
      await new Promise((r) => setTimeout(r, 0));
      await expect(f('http://x.test/2')).rejects.toBeInstanceOf(SourceRefusedError);
      release(new Response('ok'));
      await probe;
      expect(await g.status('s')).toEqual({ state: 'clear' });
      expect(calls).toEqual(['http://x.test/1']);
    });
  });
});
