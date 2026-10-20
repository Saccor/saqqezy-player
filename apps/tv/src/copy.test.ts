import { describe, expect, it } from 'vitest';
import { FAV_COPY, favChangedToast, favToggleLabel } from './copy.ts';

describe('favourites copy', () => {
  it('is lowercase "favourites" everywhere, and the failure toast is one sentence', () => {
    for (const s of Object.values(FAV_COPY)) expect(s).toMatch(/favourites/);
    for (const s of Object.values(FAV_COPY)) expect(s).not.toMatch(/Favourites/);
    expect(FAV_COPY.failed).toBe("Couldn't change favourites.");
  });

  it('the menu label says what a press does; the toast says what is now true', () => {
    expect(favToggleLabel(false)).toBe('Add to favourites');
    expect(favToggleLabel(true)).toBe('Remove from favourites');
    expect(favChangedToast(true)).toBe('Added to favourites');
    expect(favChangedToast(false)).toBe('Removed from favourites');
  });
});
