import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackJournal, sanitizeEvent, type JournalEvent, type JournalPersist } from '../src/index.ts';

function memory(initial: string | null = null): JournalPersist & { saved: string[]; value: string | null } {
  const m = {
    saved: [] as string[],
    value: initial,
    load: () => m.value,
    save: (json: string) => { m.saved.push(json); m.value = json; },
  };
  return m;
}

const stop = (t: number): JournalEvent => ({ k: 'stop', t });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('sanitizeEvent', () => {
  it('keeps a rateWait event (noted while the connection limit of a source is full)', () => {
    expect(sanitizeEvent({ k: 'rateWait', t: 1, delayMs: 4200 })).toEqual({ k: 'rateWait', t: 1, delayMs: 4200 });
  });

  it('keeps a catch-up miss with its mode and status only', () => {
    expect(sanitizeEvent({ k: 'catchupMissing', t: 1, mode: 'xc', httpStatus: 404 })).toEqual({ k: 'catchupMissing', t: 1, mode: 'xc', httpStatus: 404 });
    expect(sanitizeEvent({ k: 'catchupMissing', t: 1, mode: 'http://x.test/a?u=1' })).toEqual({ k: 'catchupMissing', t: 1 });
  });

  it('keeps the background-return page events', () => {
    expect(sanitizeEvent({ k: 'page', t: 1, what: 'resume_restore' })).toEqual({ k: 'page', t: 1, what: 'resume_restore' });
    expect(sanitizeEvent({ k: 'page', t: 1, what: 'resume_reopen' })).toEqual({ k: 'page', t: 1, what: 'resume_reopen' });
  });

  it('drops unknown kinds, a missing or non-finite time, and non-objects', () => {
    expect(sanitizeEvent({ k: 'nope', t: 1 })).toBeUndefined();
    expect(sanitizeEvent({ k: 'stop' })).toBeUndefined();
    expect(sanitizeEvent({ k: 'stop', t: Number.NaN })).toBeUndefined();
    expect(sanitizeEvent(null)).toBeUndefined();
    expect(sanitizeEvent('stop')).toBeUndefined();
  });

  it('keeps a header note (a token, never a value)', () => {
    expect(sanitizeEvent({ k: 'note', t: 1, what: 'refererDropped' })).toEqual({ k: 'note', t: 1, what: 'refererDropped' });
    expect(sanitizeEvent({ k: 'note', t: 1, what: 'http://ref.test/' })).toEqual({ k: 'note', t: 1 });
  });

  it('trims the channel name, keeps only safe detail ids, drops non-finite numbers and undefined fields', () => {
    const long = `  ${'x'.repeat(80)}  `;
    expect(sanitizeEvent({ k: 'play', t: 1, channel: long, preset: 'balanced', urls: 2 }))
      .toEqual({ k: 'play', t: 1, channel: 'x'.repeat(60), preset: 'balanced', urls: 2 });
    expect(sanitizeEvent({ k: 'error', t: 1, code: 'NETWORK', detail: 'fragLoadError' }))
      .toEqual({ k: 'error', t: 1, code: 'NETWORK', detail: 'fragLoadError' });
    expect(sanitizeEvent({ k: 'error', t: 1, code: 'NETWORK', detail: 'http://host/u/p' }))
      .toEqual({ k: 'error', t: 1, code: 'NETWORK' });
    expect(sanitizeEvent({ k: 'stall', t: 1, phase: 'start', bufferAheadS: Number.POSITIVE_INFINITY, x: undefined }))
      .toEqual({ k: 'stall', t: 1, phase: 'start' });
    expect(sanitizeEvent({ k: 'play', t: 1, channel: '   ', preset: 'low', urls: 1 }))
      .toEqual({ k: 'play', t: 1, preset: 'low', urls: 1 });
  });
});

describe('sanitizeEvent tokens', () => {
  it('drops string fields that are not plain tokens, and non-primitive values', () => {
    expect(sanitizeEvent({ k: 'stop', t: 1, extra: 'http://host/x' })).toEqual({ k: 'stop', t: 1 });
    expect(sanitizeEvent({ k: 'stop', t: 1, extra: { a: 1 } })).toEqual({ k: 'stop', t: 1 });
    expect(sanitizeEvent({ k: 'stop', t: 1, extra: ['a'] })).toEqual({ k: 'stop', t: 1 });
    expect(sanitizeEvent({ k: 'stop', t: 1, extra: () => 1 })).toEqual({ k: 'stop', t: 1 });
    expect(sanitizeEvent({ k: 'playing', t: 1, attempt: 1, engine: 'hls.js' })).toEqual({ k: 'playing', t: 1, attempt: 1, engine: 'hls.js' });
  });
});

describe('PlaybackJournal', () => {
  it('keeps the newest events up to the capacity, oldest first', () => {
    const j = new PlaybackJournal({ capacity: 3 });
    for (let t = 1; t <= 5; t++) j.add(stop(t));
    expect(j.entries().map((e) => e.t)).toEqual([3, 4, 5]);
  });

  it('defaults to 200 events and ignores invalid events', () => {
    const j = new PlaybackJournal();
    for (let t = 1; t <= 205; t++) j.add(stop(t));
    j.add({ k: 'bogus', t: 1 } as unknown as JournalEvent);
    expect(j.entries()).toHaveLength(200);
    expect(j.entries()[0]!.t).toBe(6);
  });

  it('entries() returns a copy', () => {
    const j = new PlaybackJournal();
    j.add(stop(1));
    (j.entries() as JournalEvent[]).push(stop(2));
    expect(j.entries()).toHaveLength(1);
  });

  it('saves deferred, at most once per second; flush saves what is pending', () => {
    const m = memory();
    const j = new PlaybackJournal({ persist: m });
    j.add(stop(1));
    expect(m.saved).toHaveLength(0); // never inside add
    vi.advanceTimersByTime(0);
    expect(m.saved).toHaveLength(1);
    j.add(stop(2));
    j.add(stop(3));
    expect(m.saved).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(m.saved).toHaveLength(2);
    expect(JSON.parse(m.saved[1]!)).toEqual({ v: 1, e: [stop(1), stop(2), stop(3)] });
    j.add(stop(4));
    j.flush();
    expect(m.saved).toHaveLength(3);
    j.flush(); // nothing new
    expect(m.saved).toHaveLength(3);
  });

  it('a backward clock step cannot stall saves beyond saveEveryMs', () => {
    const m = memory();
    let skew = 0;
    const j = new PlaybackJournal({ persist: m, now: () => Date.now() + skew });
    j.add(stop(1));
    vi.advanceTimersByTime(0);
    expect(m.saved).toHaveLength(1);
    skew = -3_600_000;
    j.add(stop(2));
    j.add(stop(3));
    vi.advanceTimersByTime(1000);
    expect(m.saved).toHaveLength(2);
  });

  it('loads what was saved, and clear() empties and saves at once', () => {
    const m = memory(JSON.stringify({ v: 1, e: [stop(1), { k: 'bogus', t: 2 }, stop(3)] }));
    const j = new PlaybackJournal({ persist: m });
    expect(j.entries()).toEqual([stop(1), stop(3)]);
    j.clear();
    expect(j.entries()).toEqual([]);
    expect(JSON.parse(m.value!)).toEqual({ v: 1, e: [] });
  });

  it('starts empty on corrupt, wrong-version or non-array data', () => {
    for (const raw of ['{', JSON.stringify({ v: 2, e: [stop(1)] }), JSON.stringify({ v: 1, e: {} }), 'null']) {
      expect(new PlaybackJournal({ persist: memory(raw) }).entries()).toEqual([]);
    }
  });

  it('load and save that throw never escape', () => {
    const bad: JournalPersist = { load: () => { throw new Error('denied'); }, save: () => { throw new Error('quota'); } };
    const j = new PlaybackJournal({ persist: bad });
    expect(() => { j.add(stop(1)); j.flush(); j.clear(); }).not.toThrow();
    j.add(stop(2));
    expect(j.entries()).toEqual([stop(2)]);
  });
});

describe('new kinds', () => {
  it.each([
    { k: 'app', t: 1, what: 'workerCrash' },
    { k: 'app', t: 1, what: 'error', name: 'TypeError' },
    { k: 'audio', t: 1, action: 'switch', from: 'dts', to: 'aac', because: 'codec' },
    { k: 'engineSwitch', t: 1, from: 'mpegts.js', to: 'native', reason: 'noAudio' },
    { k: 'beta', t: 1, what: 'manifestOk' },
  ])('keeps %j', (e) => expect(sanitizeEvent(e)).toEqual(e));
  it('drops a name that is free text', () => {
    expect(sanitizeEvent({ k: 'app', t: 1, what: 'error', name: 'http://x/y' })).toEqual({ k: 'app', t: 1, what: 'error' });
  });
});

describe('sanitizeEvent: multiview', () => {
  it('keeps a numeric tile', () => {
    expect(sanitizeEvent({ k: 'stop', t: 1, tile: 2 })).toEqual({ k: 'stop', t: 1, tile: 2 });
  });
});

describe('journal: multiview events', () => {
  it('keeps the new kinds with numbers and tokens only', () => {
    expect(sanitizeEvent({ k: 'tileRefused', t: 1, tile: 1, httpStatus: 403, concurrent: 1, scope: 'tile', reported: 2, url: 'http://a.example.test/x' }))
      .toEqual({ k: 'tileRefused', t: 1, tile: 1, httpStatus: 403, concurrent: 1, scope: 'tile', reported: 2 });
    expect(sanitizeEvent({ k: 'displaced', t: 1, tile: 0, byTile: 1, afterMs: 3000 })).toEqual({ k: 'displaced', t: 1, tile: 0, byTile: 1, afterMs: 3000 });
    expect(sanitizeEvent({ k: 'pingPong', t: 1, tile: 1 })).toEqual({ k: 'pingPong', t: 1, tile: 1 });
    expect(sanitizeEvent({ k: 'escalated', t: 1, tile: 1 })).toEqual({ k: 'escalated', t: 1, tile: 1 });
  });
});
