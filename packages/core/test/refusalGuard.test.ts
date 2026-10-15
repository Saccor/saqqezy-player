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
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN });
    advance(2 * MIN);
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN });
    advance(10 * MIN);
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'manual' });
    advance(24 * 60 * MIN);
    expect(g.isBlocked('s')).toBe(true);
  });

  test('a refusal while already blocked does not move up the ladder', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.report('s', 'refused');
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN });
  });

  test('an answer clears the record, so the ladder restarts at 2 min', async () => {
    const g = make();
    await g.report('s', 'refused');
    advance(2 * MIN);
    await g.report('s', 'answered');
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN });
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
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t - 30_000 + 2 * MIN });
    expect(g.isBlocked('s')).toBe(true);
  });

  test('manual only survives a restart', async () => {
    const g = make();
    for (const wait of [2 * MIN, 10 * MIN, 0]) {
      await g.report('s', 'refused');
      advance(wait);
    }
    expect(await make().status('s')).toEqual({ state: 'manual' });
  });

  test('retry unblocks one attempt and keeps the step', async () => {
    const g = make();
    await g.report('s', 'refused');
    await g.retry('s');
    expect(await g.status('s')).toEqual({ state: 'clear' });
    await g.report('s', 'refused');
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN });
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
    expect(await g.status('s')).toEqual({ state: 'manual' });
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
      ['s', { state: 'waiting', until }, 'refused'],
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
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN });
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
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 10 * MIN });
  });

  test('requests in flight when the first refusal lands count once', async () => {
    const g = make();
    const f = g.wrap('s', base);
    answer = async () => new Response('', { status: 403 });
    await Promise.all([f('http://x.test/1'), f('http://x.test/2'), f('http://x.test/3')]);
    expect(await g.status('s')).toEqual({ state: 'waiting', until: t + 2 * MIN });
  });
});
