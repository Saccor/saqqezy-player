import { describe, expect, it, vi } from 'vitest';
import type { VodTile } from '@iptv/app-api';
import { createFavToggle } from './favToggle.ts';

const tile = (over: Partial<VodTile> = {}): VodTile => ({ id: 's:m1', kind: 'movie', title: 'Synthetic Film 1', categoryId: '1', watched: false, favourite: false, ...over });

describe('createFavToggle', () => {
  it('saves, shows the new state at once, then reloads', async () => {
    const setFavourite = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    const fav = createFavToggle({ alive: () => true, reload, setFavourite, toast: vi.fn() });
    expect(fav.apply(tile())).toEqual(tile());
    await fav.toggle(tile());
    expect(setFavourite).toHaveBeenCalledWith('s:m1', true);
    expect(fav.apply(tile())?.favourite).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    fav.clear();
    expect(fav.apply(tile())?.favourite).toBe(false);
    expect(fav.apply(undefined)).toBeUndefined();
  });
  it('toasts on failure and changes nothing', async () => {
    const toast = vi.fn();
    const reload = vi.fn(async () => undefined);
    const fav = createFavToggle({ alive: () => true, reload, setFavourite: vi.fn(async () => { throw new Error('x'); }), toast });
    await fav.toggle(tile({ favourite: true }));
    expect(toast).toHaveBeenCalledWith("Couldn't save that. Try again.");
    expect(fav.apply(tile({ favourite: true }))?.favourite).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
  it('does nothing after the screen is gone', async () => {
    let alive = true;
    const toast = vi.fn();
    const reload = vi.fn(async () => undefined);
    const fav = createFavToggle({ alive: () => alive, reload, setFavourite: vi.fn(async () => { alive = false; }), toast });
    await fav.toggle(tile());
    expect(reload).not.toHaveBeenCalled();
    expect(fav.apply(tile())?.favourite).toBe(false);
    const fav2 = createFavToggle({ alive: () => alive, reload, setFavourite: vi.fn(async () => { throw new Error('x'); }), toast });
    await fav2.toggle(tile());
    expect(toast).not.toHaveBeenCalled();
  });
});
