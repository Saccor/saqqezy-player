import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SourceRefusedError } from '../src/errors.ts';
import { RefusalGuard, streamCooldownKey, type SourceCooldown } from '../src/net/refusalGuard.ts';
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

  test('2 min, then 10 min, then 30 min for the third refusal and every later one', async () => {
    const g = make();
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN, reason: 'refused' });
    advance(2 * MIN);
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
    advance(10 * MIN);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
    advance(30 * MIN);
    expect(g.isBlocked('s')).toBe(false); // one probe may go out
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
  });

  test('the end of the 30 min wait is announced, like every other wait', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    await g.report('s', 'refused');
    const seen: string[] = [];
    g.onChange((_k, _c, cause) => seen.push(cause));
    advance(30 * MIN);
    expect(seen).toEqual(['expired']);
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

  test('the 30 min wait survives a restart', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN, 0]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    expect(await make().status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
  });

  test('a stored manual-only record from an older version allows one probe; a refused probe waits 30 min', async () => {
    await storage.setMeta('refusal:s', { step: 3, until: null });
    const g = make();
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
  });

  test('retry unblocks one attempt and keeps the step', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.retry('s');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
  });

  test('a refused retry on the third step waits 30 min again', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN, 0]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    await g.retry('s');
    expect(g.isBlocked('s')).toBe(false);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
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

  test('on the 30 min step it overrides the wait (both ways), then allows one probe', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    await g.report('s', 'refused', { retryAfterMs: 3 * MIN });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 3 * MIN, reason: 'refused' });
    advance(3 * MIN);
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused', { retryAfterMs: 45 * MIN });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 45 * MIN, reason: 'refused' });
    advance(45 * MIN);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
  });

  test('a refusal with Retry-After on the 30 min step re-arms a wait, after a manual retry too', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN, 0]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30 * MIN, reason: 'refused' });
    await g.retry('s');
    await g.report('s', 'refused', { retryAfterMs: 4 * MIN });
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 4 * MIN, reason: 'refused' });
    const seen: string[] = [];
    g.onChange((_k, _c, cause) => seen.push(cause));
    advance(4 * MIN);
    expect(seen).toEqual(['expired']);
    expect(g.isBlocked('s')).toBe(false);
  });

  test('wrap: a 503 with Retry-After uses the header', async () => {
    const g = make();
    await g.wrap('s', async () => new Response('', { status: 503, headers: { 'Retry-After': '600' } }))('http://x.test/a');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN, reason: 'refused' });
  });

  test('wrap: an HTTP-date in the past clamps to 30 s', async () => {
    const g = make();
    const past = new Date(t - 60 * MIN).toUTCString();
    await g.wrap('s', async () => new Response('', { status: 429, headers: { 'Retry-After': past } }))('http://x.test/a');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 30_000, reason: 'refused' });
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

  test('a trip whose wait ended more than 5 min ago has decayed: one failure starts a new run', async () => {
    const g = make();
    await fail3(g);
    advance(1 * MIN + 5 * MIN + 1);
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'failed');
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual(unreachable(t + 1 * MIN)); // the ladder starts over at 1 min
  });

  test('within 5 min of the wait ending, a failure still moves up', async () => {
    const g = make();
    await fail3(g);
    advance(1 * MIN + 5 * MIN);
    await g.report('s', 'failed');
    expect(await g.status('s')).toEqual(unreachable(t + 5 * MIN));
  });

  test('a decayed trip is no probe: requests run in parallel again', async () => {
    const g = make();
    await fail3(g);
    advance(7 * MIN);
    const releases: ((r: Response) => void)[] = [];
    const f = g.wrap('s', () => new Promise((r) => { releases.push(r); }));
    const a = f('http://x.test/1');
    const b = f('http://x.test/2');
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(2);
    for (const r of releases) r(new Response('ok'));
    await Promise.all([a, b]);
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

    test('blocked requests say which ladder blocks', async () => {
      const g = make();
      const f = g.wrap('s', async () => new Response('ok'));
      await fail3(g);
      await expect(f('http://x.test/a')).rejects.toMatchObject({ name: 'SourceRefused', reason: 'unreachable', message: "Your source isn't answering. The app is waiting so it doesn't flood it." });
      await g.report('r', 'refused');
      await expect(g.wrap('r', async () => new Response('ok'))('http://x.test/a'))
        .rejects.toMatchObject({ name: 'SourceRefused', reason: 'refused', message: "Your source is refusing connections. The app is waiting so you don't get blocked." });
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

describe('streamCooldownKey', () => {
  test("a stream refusal is keyed by source and the stream URL's host and port", () => {
    expect(streamCooldownKey('s1', 'http://a.example.test:8080/live/u/p/1.ts')).toBe('s1@a.example.test:8080');
    expect(streamCooldownKey('s1', 'https://B.Example.test/x.m3u8?token=1')).toBe('s1@b.example.test');
    expect(streamCooldownKey('s1', 'http://a.example.test:80/1.ts')).toBe('s1@a.example.test');
  });

  test('never carries credentials or the path', () => {
    expect(streamCooldownKey('s1', 'http://user:pass@a.example.test:8080/live/user/pass/1.ts')).toBe('s1@a.example.test:8080');
  });

  test('https on 443, IPv6 and a udp multicast group', () => {
    expect(streamCooldownKey('s1', 'https://a.example.test:443/x.m3u8')).toBe('s1@a.example.test');
    expect(streamCooldownKey('s1', 'http://[::1]:8080/live/1.ts')).toBe('s1@[::1]:8080');
    expect(streamCooldownKey('s1', 'http://[2001:db8::1]/live/1.ts')).toBe('s1@[2001:db8::1]');
    expect(streamCooldownKey('s1', 'udp://@239.0.0.1:1234')).toBe('s1@239.0.0.1:1234');
  });

  test('an URL without a host gets its own stream key, never the source key (the API stays open)', () => {
    expect(streamCooldownKey('s1', 'not a url')).toBe('s1@stream');
    expect(streamCooldownKey('s1', 'file:///media/a.ts')).toBe('s1@stream');
  });

  test('host keys and the source key are independent records', async () => {
    const g = make();
    const a = streamCooldownKey('s1', 'http://a.example.test/1.ts');
    await g.report(a, 'refused');
    expect(g.isBlocked(a)).toBe(true);
    expect(g.isBlocked('s1')).toBe(false);
    expect(g.isBlocked(streamCooldownKey('s1', 'http://b.example.test/1.ts'))).toBe(false);
  });
});

describe('RefusalGuard host keys of a source', () => {
  const a = streamCooldownKey('s1', 'http://a.example.test/1.ts');
  const b = streamCooldownKey('s1', 'http://b.example.test/1.ts');
  const other = streamCooldownKey('s2', 'http://a.example.test/1.ts');

  test('forget(source) drops its host keys too, also after a reload, and no wait of theirs ends with an event', async () => {
    const g = make();
    await g.report(a, 'refused');
    await g.report(b, 'refused');
    await g.report(other, 'refused');
    const fresh = make(); // a reload: nothing loaded yet
    const seen: string[] = [];
    fresh.onChange((k, _c, cause) => seen.push(`${k}:${cause}`));
    await fresh.forget('s1');
    expect(await fresh.status(a)).toEqual({ state: 'clear' });
    expect(await fresh.status(b)).toEqual({ state: 'clear' });
    expect(fresh.isBlocked(other)).toBe(false); // not loaded in this instance
    expect(await fresh.status(other)).toMatchObject({ state: 'waiting' });
    expect(await storage.getMeta(`refusal:${a}`)).toBeNull();
    const before = seen.length;
    advance(60 * MIN);
    expect(seen.slice(before).filter((x) => x.startsWith('s1@'))).toEqual([]);
    // The first instance's timers belong to records this test dropped elsewhere: forget there as well.
    await g.forget('s1');
    const seenOld: string[] = [];
    g.onChange((k, _c, cause) => seenOld.push(`${k}:${cause}`));
    advance(60 * MIN);
    expect(seenOld.filter((x) => x.startsWith('s1@'))).toEqual([]);
  });

  test('retryAll(source) lets one probe through for the source and each of its host keys', async () => {
    const g = make();
    await g.report('s1', 'refused');
    await g.report(a, 'refused');
    await g.report(other, 'refused');
    await make().retryAll('s1'); // tracked keys survive a reload
    const fresh = make();
    expect(await fresh.status('s1')).toEqual({ state: 'clear' });
    expect(await fresh.status(a)).toEqual({ state: 'clear' });
    expect(await fresh.status(other)).toMatchObject({ state: 'waiting' });
  });
});
