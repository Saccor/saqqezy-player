import { describe, expect, test } from 'vitest';
import { greenOpensGrid } from './browseNavLogic.ts';

describe('greenOpensGrid', () => {
  test('Green opens the All grid only while the catalogue is ready, never on loading, empty or failed', () => {
    expect(greenOpensGrid('ready')).toBe(true);
    for (const s of ['loading', 'empty', 'error', undefined]) expect(greenOpensGrid(s)).toBe(false);
  });
});
