import { describe, expect, test } from 'vitest';
import type { VodPlayable } from '@iptv/app-api';
import { CANT_PLAY, createVodLauncher } from './launch.ts';

const playable = { url: 'http://example.test/movie/u/p/1.mp4' } as VodPlayable;

const setup = (answer: () => Promise<VodPlayable | undefined>) => {
  const s = { alive: true, overlay: undefined as string | undefined, pushed: [] as VodPlayable[], toasts: [] as string[], calls: 0 };
  const launcher = createVodLauncher({
    alive: () => s.alive,
    topOverlay: () => s.overlay,
    getPlayable: (id) => { s.calls++; expect(id).toBe('s:m1'); return answer(); },
    push: (p) => s.pushed.push(p),
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
