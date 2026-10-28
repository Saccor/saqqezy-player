import { describe, expect, it, vi } from 'vitest';
import { createLayerSet } from './layerSet.ts';
import { createRouter } from './router.ts';

describe('createLayerSet', () => {
  it('opens layers on top; Back pops the top one and calls its onClose', () => {
    const r = createRouter();
    const layers = createLayerSet(r);
    const closeA = vi.fn();
    const closeB = vi.fn();
    layers.open('a', closeA);
    layers.open('b', closeB);
    expect(r.overlays()).toEqual(['a', 'b']);
    r.back();
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
    expect(r.overlays()).toEqual(['a']);
  });

  it('reopening an id moves it on top without calling the old onClose', () => {
    const r = createRouter();
    const layers = createLayerSet(r);
    const first = vi.fn();
    const second = vi.fn();
    layers.open('menu', first);
    layers.open('info', () => undefined);
    layers.open('menu', second);
    expect(r.overlays()).toEqual(['info', 'menu']);
    r.back();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('remove and removeAll take layers away without onClose', () => {
    const r = createRouter();
    const layers = createLayerSet(r);
    const close = vi.fn();
    layers.open('a', close);
    layers.open('b', close);
    layers.open('c', close);
    layers.remove('b');
    expect(r.overlays()).toEqual(['a', 'c']);
    layers.removeAll();
    expect(r.overlays()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    layers.remove('missing'); // nothing open: no-op
  });

  it('a layer popped by Back is no longer removed later (another screen may reuse its id)', () => {
    const r = createRouter();
    const layers = createLayerSet(r);
    layers.open('a', () => undefined);
    r.back();
    r.pushOverlay('a', () => undefined); // someone else's layer with the same id
    layers.removeAll();
    expect(r.overlays()).toEqual(['a']);
  });
});
