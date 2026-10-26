import { describe, expect, it } from 'vitest';
import { drawnFocus } from './focusStyle.ts';

describe('drawnFocus (spec 2026-10-26 §1.2: one hover style, equal to focus)', () => {
  it('draws the key selection, or the hovered item in pointer mode', () => {
    expect(drawnFocus(2, undefined, false)).toBe(2);
    expect(drawnFocus(2, 4, false)).toBe(2);
    expect(drawnFocus(2, 4, true)).toBe(4);
    expect(drawnFocus(2, undefined, true)).toBe(2);
  });
});
