import { describe, expect, test } from 'vitest';
import { browseRowSlots, greenOpensGrid } from './browseNavLogic.ts';

describe('browseRowSlots', () => {
  const frame = { top: 262, gap: 36, bottom: 1080, peek: 62 };
  test('the focused row on top, the next below, then a peek', () => {
    expect(browseRowSlots(5, 322, 0, frame, 'peek')).toEqual([
      { index: 0, y: 262 }, { index: 1, y: 620 }, { index: 2, y: 978 },
    ]);
    expect(browseRowSlots(5, 322, 3, frame, 'peek')[0]).toEqual({ index: 3, y: 262 });
  });
  test('pointer mode: only whole rows; a focus past the end is clamped; no rows, nothing', () => {
    expect(browseRowSlots(5, 322, 0, { ...frame, bottom: 1000 }, 'whole')).toEqual([{ index: 0, y: 262 }, { index: 1, y: 620 }]);
    expect(browseRowSlots(2, 322, 7, frame, 'peek')).toEqual([{ index: 1, y: 262 }]);
    expect(browseRowSlots(0, 322, 0, frame, 'peek')).toEqual([]);
  });
});

describe('greenOpensGrid', () => {
  test('Green opens the All grid only while the catalogue is ready, never on loading, empty or failed', () => {
    expect(greenOpensGrid('ready')).toBe(true);
    for (const s of ['loading', 'empty', 'error', undefined]) expect(greenOpensGrid(s)).toBe(false);
  });
});
