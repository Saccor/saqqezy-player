import { describe, expect, test } from 'vitest';
import type { SeriesView, VodPlayable } from '@iptv/app-api';
import { CANT_PLAY, createVodLauncher, playSeriesPrimary, type VodLauncher } from './launch.ts';

const playable = { url: 'http://example.test/movie/u/p/1.mp4' } as VodPlayable;

const setup = (answer: () => Promise<VodPlayable | undefined>) => {
  const s = { alive: true, overlay: undefined as string | undefined, pushed: [] as VodPlayable[], seriesIds: [] as Array<string | undefined>, fromStarts: [] as boolean[], toasts: [] as string[], calls: 0 };
  const launcher = createVodLauncher({
    alive: () => s.alive,
    topOverlay: () => s.overlay,
    getPlayable: (id, seriesId) => { s.calls++; expect(id).toBe('s:m1'); s.seriesIds.push(seriesId); return answer(); },
    push: (p, fromStart) => { s.pushed.push(p); s.fromStarts.push(fromStart); },
    toast: (m) => s.toasts.push(m),
  });
  return { s, launcher };
};
const deferred = () => {
  let resolve!: (p: VodPlayable | undefined) => void;
  const p = new Promise<VodPlayable | undefined>((r) => { resolve = r; });
  return { p, resolve };
};

describe('createVodLauncher', () => {
  test('pushes the player with the playable', async () => {
    const { s, launcher } = setup(async () => playable);
    await launcher.play('s:m1');
    expect(s.pushed).toEqual([playable]);
    expect(s.toasts).toEqual([]);
  });

  test('fromStart and seriesId are passed through; both default to off', async () => {
    const plain = setup(async () => playable);
    await plain.launcher.play('s:m1');
    expect(plain.s.fromStarts).toEqual([false]);
    expect(plain.s.seriesIds).toEqual([undefined]);
    const opts = setup(async () => playable);
    await opts.launcher.play('s:m1', { seriesId: 's:series1', fromStart: true });
    expect(opts.s.fromStarts).toEqual([true]);
    expect(opts.s.seriesIds).toEqual(['s:series1']);
  });

  test('no playable, or a failure: the can\'t-play toast', async () => {
    const none = setup(async () => undefined);
    await none.launcher.play('s:m1');
    expect(none.s.toasts).toEqual([CANT_PLAY]);
    const failing = setup(async () => { throw new Error('boom'); });
    await failing.launcher.play('s:m1');
    expect(failing.s.toasts).toEqual([CANT_PLAY]);
    expect(failing.s.pushed).toEqual([]);
    // Not busy afterwards: a second press asks again.
    await failing.launcher.play('s:m1');
    expect(failing.s.calls).toBe(2);
  });

  test('busy: a second press while the first is in flight is ignored', async () => {
    const d = deferred();
    const { s, launcher } = setup(() => d.p);
    const first = launcher.play('s:m1');
    expect(launcher.busy()).toBe(true);
    await launcher.play('s:m1');
    expect(s.calls).toBe(1);
    d.resolve(playable);
    await first;
    expect(launcher.busy()).toBe(false);
    expect(s.pushed).toHaveLength(1);
  });

  test('an overlay open at the press: nothing is asked', async () => {
    const { s, launcher } = setup(async () => playable);
    s.overlay = 'menu';
    await launcher.play('s:m1');
    expect(s.calls).toBe(0);
  });

  test('an overlay opened, or the screen closed, during the wait: nothing is pushed or toasted', async () => {
    for (const change of ['overlay', 'dead'] as const) {
      const d = deferred();
      const { s, launcher } = setup(() => d.p);
      const run = launcher.play('s:m1');
      if (change === 'overlay') s.overlay = 'menu'; else s.alive = false;
      d.resolve(playable);
      await run;
      expect(s.pushed).toEqual([]);
      expect(s.toasts).toEqual([]);
    }
  });

  test('cancel: a late answer for the cancelled press is dropped, and a new press can start', async () => {
    const d = deferred();
    const { s, launcher } = setup(() => d.p);
    const run = launcher.play('s:m1');
    launcher.cancel();
    expect(launcher.busy()).toBe(false);
    d.resolve(undefined);
    await run;
    expect(s.toasts).toEqual([]);
    expect(s.pushed).toEqual([]);
  });
});

describe('playSeriesPrimary', () => {
  const primary = { episodeId: 'e5', season: 1, episode: 5, resumeMs: 0, mode: 'continue' as const };
  const seriesView = (withPrimary: boolean) => ({ ...(withPrimary ? { primary } : {}) }) as SeriesView;
  const fakeLauncher = (busy = false) => {
    const plays: Array<[string, string | undefined]> = [];
    const launcher: VodLauncher = { busy: () => busy, cancel: () => undefined, play: async (id, o) => { plays.push([id, o?.seriesId]); } };
    return { launcher, plays };
  };
  const run = (o: { view?: SeriesView; load?: () => Promise<SeriesView | undefined>; still?: () => boolean; busy?: boolean }) => {
    const { launcher, plays } = fakeLauncher(o.busy);
    let loads = 0;
    let none = 0;
    const done = playSeriesPrimary({
      seriesId: 'show', launcher, view: () => o.view,
      load: () => { loads++; return (o.load ?? (async () => undefined))(); },
      still: o.still ?? (() => true),
      noPrimary: () => { none++; },
    });
    return { done, plays, counts: () => ({ loads, none }) };
  };

  test('a loaded view plays its primary at once, without loading', async () => {
    const r = run({ view: seriesView(true) });
    await r.done;
    expect(r.plays).toEqual([['e5', 'show']]);
    expect(r.counts()).toEqual({ loads: 0, none: 0 });
  });

  test('before the view loads it waits for the load, then plays the primary', async () => {
    const r = run({ load: async () => seriesView(true) });
    await r.done;
    expect(r.plays).toEqual([['e5', 'show']]);
    expect(r.counts()).toEqual({ loads: 1, none: 0 });
  });

  test('no primary after loading (or a failed load) calls noPrimary', async () => {
    const a = run({ load: async () => seriesView(false) });
    await a.done;
    const b = run({ load: async () => { throw new Error('x'); } });
    await b.done;
    expect([a.plays, b.plays]).toEqual([[], []]);
    expect([a.counts().none, b.counts().none]).toEqual([1, 1]);
  });

  test('a press that no longer applies after the load (screen gone, focus moved) does nothing', async () => {
    const r = run({ load: async () => seriesView(true), still: () => false });
    await r.done;
    expect(r.plays).toEqual([]);
    expect(r.counts().none).toBe(0);
  });

  test('ignored while the launcher is busy', async () => {
    const r = run({ view: seriesView(true), busy: true });
    await r.done;
    expect(r.plays).toEqual([]);
    expect(r.counts()).toEqual({ loads: 0, none: 0 });
  });
});
