import { describe, expect, test } from 'vitest';
import { dropdownWidth } from './dropdownLogic.ts';

describe('dropdownWidth', () => {
  test('grows with the label, has room for the chevron, and is capped', () => {
    expect(dropdownWidth('Action', 40)).toBe(Math.ceil(6 * 40 * 0.6) + 16 + 28 + 48);
    expect(dropdownWidth('A', 24)).toBeLessThan(dropdownWidth('A much longer category', 24));
    expect(dropdownWidth('x'.repeat(200), 40)).toBe(900);
  });
});
