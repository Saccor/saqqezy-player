import { describe, expect, test } from 'vitest';
import { dropLayer, failLayer, heroArt, pushLayer, settleLayer, type FadeLayer } from './fadeLogic.ts';

const shown = (id: number, url: string): FadeLayer => ({ id, url, shown: true });
const fading = (id: number, url: string): FadeLayer => ({ id, url, shown: false });

describe('fadeLogic', () => {
  test('the first image is one layer that still has to fade in', () => {
    expect(pushLayer([], 'a.jpg', 1)).toEqual([fading(1, 'a.jpg')]);
  });

  test('a new image goes on top of the shown one', () => {
    expect(pushLayer([shown(1, 'a.jpg')], 'b.jpg', 2)).toEqual([shown(1, 'a.jpg'), fading(2, 'b.jpg')]);
  });

  test('the same image again changes nothing', () => {
    const ls = [shown(1, 'a.jpg')];
    expect(pushLayer(ls, 'a.jpg', 2)).toBe(ls);
    const mid = [shown(1, 'a.jpg'), fading(2, 'b.jpg')];
    expect(pushLayer(mid, 'b.jpg', 3)).toBe(mid);
  });

  test('a third image while one is fading replaces the fading one, over the last shown one', () => {
    expect(pushLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], 'c.jpg', 3)).toEqual([shown(1, 'a.jpg'), fading(3, 'c.jpg')]);
  });

  test('a new image while the very first is still fading replaces it', () => {
    expect(pushLayer([fading(1, 'a.jpg')], 'b.jpg', 2)).toEqual([fading(2, 'b.jpg')]);
  });

  test('back to the shown image drops the fading one', () => {
    expect(pushLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], 'a.jpg', 3)).toEqual([shown(1, 'a.jpg')]);
  });

  test('no image clears every layer', () => {
    expect(pushLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], undefined, 3)).toEqual([]);
  });

  test('a layer done fading is shown and the layers under it go', () => {
    expect(settleLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], 2)).toEqual([shown(2, 'b.jpg')]);
    expect(settleLayer([fading(1, 'a.jpg')], 1)).toEqual([shown(1, 'a.jpg')]);
  });

  test('settling a layer that is gone changes nothing', () => {
    const ls = [shown(1, 'a.jpg'), fading(3, 'c.jpg')];
    expect(settleLayer(ls, 2)).toBe(ls);
  });

  test('a failed layer is dropped; the one under it stays', () => {
    expect(dropLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], 2)).toEqual([shown(1, 'a.jpg')]);
    const ls = [shown(1, 'a.jpg')];
    expect(dropLayer(ls, 7)).toBe(ls);
  });

  test('a failed top (fading) layer drops every layer; a failed lower one only itself', () => {
    expect(failLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], 2)).toEqual([]);
    expect(failLayer([fading(1, 'a.jpg')], 1)).toEqual([]);
    expect(failLayer([shown(1, 'a.jpg'), fading(2, 'b.jpg')], 1)).toEqual([fading(2, 'b.jpg')]);
    const ls = [shown(1, 'a.jpg')];
    expect(failLayer(ls, 7)).toBe(ls);
  });

  test('hero art: the last image stays while the focused title is pending, then switches to its art or none', () => {
    expect(heroArt('a.jpg', true, undefined)).toBe('a.jpg');
    expect(heroArt(undefined, true, undefined)).toBeUndefined();
    expect(heroArt('a.jpg', false, 'b.jpg')).toBe('b.jpg');
    expect(heroArt('a.jpg', false, undefined)).toBeUndefined();
  });
});
