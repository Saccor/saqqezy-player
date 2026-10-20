import { describe, expect, it } from 'vitest';
import { clampIndex } from './optionsMenuLogic.ts';

describe('clampIndex', () => {
  it('keeps an index inside the list', () => {
    expect(clampIndex(1, 3)).toBe(1);
  });

  it('pulls a selection back onto the last row when the list shrinks under it', () => {
    expect(clampIndex(4, 3)).toBe(2);
  });

  it('never goes below the first row', () => {
    expect(clampIndex(-1, 3)).toBe(0);
  });

  it('gives 0 for an empty list', () => {
    expect(clampIndex(2, 0)).toBe(0);
  });
});
