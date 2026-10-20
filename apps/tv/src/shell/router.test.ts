import { describe, expect, it, vi } from 'vitest';
import { createRouter } from './router.ts';

describe('router screen stack', () => {
  it('starts empty and reset sets a single root', () => {
    const r = createRouter();
    expect(r.current()).toBeUndefined();
    r.reset('home', { groupId: 'g1' });
    expect(r.current()).toEqual({ screen: 'home', params: { groupId: 'g1' } });
    expect(r.depth()).toBe(1);
  });

  it('below is the screen a pop reveals, undefined on the root', () => {
    const r = createRouter();
    expect(r.below()).toBeUndefined();
    r.reset('home');
    expect(r.below()).toBeUndefined();
    r.push('player', { channelId: 'c1' });
    r.push('search');
    expect(r.below()).toEqual({ screen: 'player', params: { channelId: 'c1' } });
    r.back();
    expect(r.below()?.screen).toBe('home');
  });

  it('push, replace and back move through the stack', () => {
    const r = createRouter();
    r.reset('home');
    r.push('search');
    r.push('player', { channelId: 'c1' });
    expect(r.current()?.screen).toBe('player');
    r.replace('search', { q: 'x' });
    expect(r.current()).toEqual({ screen: 'search', params: { q: 'x' } });
    expect(r.depth()).toBe(3);
    expect(r.back()).toBe('screen');
    expect(r.current()?.screen).toBe('search');
    expect(r.back()).toBe('screen');
    expect(r.current()?.screen).toBe('home');
  });

  it('back on the root screen reports root and keeps the screen', () => {
    const r = createRouter();
    r.reset('home');
    expect(r.back()).toBe('root');
    expect(r.current()?.screen).toBe('home');
  });

  it('replace on an empty stack pushes', () => {
    const r = createRouter();
    r.replace('addSource');
    expect(r.depth()).toBe(1);
  });

  it('notifies subscribers on screen changes only', () => {
    const r = createRouter();
    const fn = vi.fn();
    const off = r.subscribe(fn);
    r.reset('home');
    r.push('settings');
    r.back();
    r.back(); // root: no change
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    r.push('search');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('router back params', () => {
  it('merges params into the revealed screen on a screen pop only', () => {
    const r = createRouter();
    r.push('home', { a: 1 });
    r.push('player', {});
    r.pushOverlay('x', () => undefined);
    r.back({ b: 2 }); // closes the overlay: params are not applied
    expect(r.current()?.screen).toBe('player');
    r.back({ b: 2 });
    expect(r.current()).toEqual({ screen: 'home', params: { a: 1, b: 2 } });
  });
});

describe('router backTo (hand-offs return to a screen lower in the stack)', () => {
  it('pops every screen above the target in one change and merges params into it', () => {
    const r = createRouter();
    r.reset('home', { a: 1 });
    r.push('search');
    r.push('player', { channelId: 'c1' });
    const fn = vi.fn();
    r.subscribe(fn);
    expect(r.backTo('home', { channelId: 's:7', at: 5 })).toBe(true);
    expect(r.current()).toEqual({ screen: 'home', params: { a: 1, channelId: 's:7', at: 5 } });
    expect(r.depth()).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('closes the open overlays first, calling their onClose', () => {
    const r = createRouter();
    r.reset('home');
    r.push('player');
    const closed = vi.fn();
    r.pushOverlay('menu', closed);
    expect(r.backTo('home')).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(r.overlays()).toEqual([]);
    expect(r.current()?.screen).toBe('home');
  });

  it('already on the target: params are merged and subscribers told (the screen re-reads them)', () => {
    const r = createRouter();
    r.reset('home');
    const fn = vi.fn();
    r.subscribe(fn);
    expect(r.backTo('home', { focusChannelId: 'c1' })).toBe(true);
    expect(r.current()).toEqual({ screen: 'home', params: { focusChannelId: 'c1' } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns false and changes nothing when the target is not in the stack', () => {
    const r = createRouter();
    r.reset('addSource');
    r.push('search');
    expect(r.backTo('home', { x: 1 })).toBe(false);
    expect(r.current()).toEqual({ screen: 'search', params: {} });
    expect(r.depth()).toBe(2);
  });

  it('stops at the topmost entry of the target', () => {
    const r = createRouter();
    r.reset('home');
    r.push('settings', { n: 1 });
    r.push('search');
    r.push('settings', { n: 2 });
    r.push('player');
    expect(r.backTo('settings')).toBe(true);
    expect(r.current()).toEqual({ screen: 'settings', params: { n: 2 } });
    expect(r.depth()).toBe(4);
  });
});

describe('router overlays and layered Back', () => {
  it('Back closes the top overlay first, then pops the screen', () => {
    const r = createRouter();
    r.reset('home');
    r.push('search');
    const order: string[] = [];
    r.pushOverlay('toast', () => order.push('toast'));
    r.pushOverlay('menu', () => order.push('menu'));
    expect(r.topOverlay()).toBe('menu');
    expect(r.back()).toBe('overlay');
    expect(r.back()).toBe('overlay');
    expect(order).toEqual(['menu', 'toast']);
    expect(r.current()?.screen).toBe('search');
    expect(r.back()).toBe('screen');
    expect(r.current()?.screen).toBe('home');
  });

  it('re-pushing an existing overlay id moves it to the top without duplicating it', () => {
    const r = createRouter();
    const a = vi.fn();
    const b = vi.fn();
    r.pushOverlay('a', a);
    r.pushOverlay('b', b);
    r.pushOverlay('a', a);
    expect(r.overlays()).toEqual(['b', 'a']);
    r.back();
    expect(a).toHaveBeenCalledOnce();
    expect(r.overlays()).toEqual(['b']);
  });

  it('the remover returned by pushOverlay removes without calling onClose', () => {
    const r = createRouter();
    const close = vi.fn();
    const remove = r.pushOverlay('toast', close);
    remove();
    expect(r.overlays()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    r.reset('home');
    expect(r.back()).toBe('root');
  });

  it('a stale remover does not remove a newer registration of the same id', () => {
    const r = createRouter();
    const removeOld = r.pushOverlay('toast', () => {});
    r.pushOverlay('toast', () => {});
    removeOld();
    expect(r.overlays()).toEqual(['toast']);
  });

  it('an onClose that throws still removes the overlay', () => {
    const r = createRouter();
    r.pushOverlay('x', () => { throw new Error('boom'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(r.back()).toBe('overlay');
    expect(r.overlays()).toEqual([]);
    err.mockRestore();
  });

  it('notifies overlay subscribers', () => {
    const r = createRouter();
    const fn = vi.fn();
    r.subscribeOverlays(fn);
    const remove = r.pushOverlay('a', () => {});
    r.back();
    remove(); // already gone: no notification
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
