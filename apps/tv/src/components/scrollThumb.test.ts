import { describe, expect, test } from 'vitest';
import { scrollThumb } from './scrollThumb.ts';

describe('scrollThumb', () => {
  test('nothing when everything fits', () => {
    expect(scrollThumb(20, 24, 0, 876)).toBeUndefined();
    expect(scrollThumb(24, 24, 0, 876)).toBeUndefined();
  });
  test('size follows the visible share, position the first row', () => {
    expect(scrollThumb(96, 24, 0, 876)).toEqual({ y: 0, h: 219 });
    expect(scrollThumb(96, 24, 72, 876)).toEqual({ y: 657, h: 219 });
    expect(scrollThumb(96, 24, 36, 876)).toEqual({ y: 329, h: 219 });
  });
  test('a long list keeps a thumb that can be seen', () => {
    expect(scrollThumb(50_000, 24, 0, 876)).toEqual({ y: 0, h: 48 });
    expect(scrollThumb(50_000, 24, 50_000, 876)).toEqual({ y: 828, h: 48 });
  });
});
