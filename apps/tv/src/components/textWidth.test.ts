import { describe, expect, it } from 'vitest';
import { keepSpaces } from './textWidth.ts';

describe('keepSpaces: space runs the renderer measures as one space', () => {
  it('keeps a single space and turns the rest of a run into no-break spaces (same width, measured)', () => {
    expect(keepSpaces('1  Channel 001')).toBe('1 \u00a0Channel 001');
    expect(keepSpaces('a   b')).toBe('a \u00a0\u00a0b');
  });
  it('leaves text without runs unchanged', () => {
    expect(keepSpaces('Added to favourites')).toBe('Added to favourites');
    expect(keepSpaces('')).toBe('');
  });
});
