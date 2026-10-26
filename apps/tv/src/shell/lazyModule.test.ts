import { describe, expect, it, vi } from 'vitest';
import { FIRST_FRAME_SCREENS, isLazyScreen, LAZY_SCREENS, lazyModule, preloadInTurn, shouldRefocusHost, tryAgain } from './lazyModule.ts';

const Comp = () => null;

describe('lazyModule', () => {
  it('imports once, shares the pending import, then reports the component as loaded', async () => {
    const importer = vi.fn(async () => Comp);
    const m = lazyModule(importer);
    expect(m.loaded()).toBeUndefined();
    const [a, b] = await Promise.all([m.load(), m.load()]);
    expect(a).toBe(Comp);
    expect(b).toBe(Comp);
    expect(m.loaded()).toBe(Comp);
    expect(importer).toHaveBeenCalledOnce();
  });

  it('a failed import can be tried again (Try again)', async () => {
    let n = 0;
    const m = lazyModule(async () => { n += 1; if (n === 1) throw new Error('chunk'); return Comp; });
    await expect(m.load()).rejects.toThrow('chunk');
    expect(m.loaded()).toBeUndefined();
    await expect(m.load()).resolves.toBe(Comp);
  });
});

describe('preloadInTurn', () => {
  it('loads one module per scheduled idle slot, in order, and survives a failure', async () => {
    const order: string[] = [];
    const slots: Array<() => void> = [];
    const mods = ['a', 'b', 'c'].map((id) => ({
      load: async () => { order.push(id); if (id === 'b') throw new Error('x'); },
    }));
    const done = preloadInTurn(mods, (run) => { slots.push(run); });
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      expect(order).toHaveLength(i);
      slots.shift()?.();
    }
    await done;
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('route table', () => {
  it('Settings (with its pages and pairing), Countries and Multiview load lazily', () => {
    expect([...LAZY_SCREENS].sort()).toEqual(['countries', 'multiview', 'settings']);
    for (const id of LAZY_SCREENS) expect(isLazyScreen(id)).toBe(true);
  });

  it('a screen opened on the first frame is never lazy, including Add source (the first-run screen)', () => {
    expect(FIRST_FRAME_SCREENS).toEqual(expect.arrayContaining(['home', 'player', 'start', 'addSource']));
    for (const id of FIRST_FRAME_SCREENS) expect(isLazyScreen(id)).toBe(false);
  });
});

describe('Try again after a failed screen load', () => {
  it('reloads the app (a browser caches a failed import, so only a reload fetches the code again)', () => {
    const reload = vi.fn();
    tryAgain(reload);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('by default reloads the page (startup returns to the last channel)', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    try {
      tryAgain();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('focus after a lazy screen mounts', () => {
  const host = { id: 'host' };
  const picker = { id: 'picker' };

  it('passes focus down again only while the empty host still holds it', () => {
    expect(shouldRefocusHost(true, host, host)).toBe(true);
  });

  it('leaves focus alone when the screen claimed it on mount (Multiview opens its picker)', () => {
    expect(shouldRefocusHost(true, picker, host)).toBe(false);
  });

  it('does nothing once the screen is gone, or before the host exists', () => {
    expect(shouldRefocusHost(false, host, host)).toBe(false);
    expect(shouldRefocusHost(true, undefined, undefined)).toBe(false);
  });
});
