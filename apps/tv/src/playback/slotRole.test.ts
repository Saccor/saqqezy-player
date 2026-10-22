import { describe, expect, it } from 'vitest';
import { slotRole } from './slotRole.ts';

describe('slotRole', () => {
  it('the primary slot outside multiview is the single-view player', () => {
    expect(slotRole(0, 0, false)).toBe('single');
    expect(slotRole(1, 1, false)).toBe('single'); // a window that kept the sound when multiview ended
  });

  it('in multiview every slot is a window, the one with sound too', () => {
    expect(slotRole(0, 0, true)).toBe('window');
    expect(slotRole(1, 0, true)).toBe('window');
  });

  it('a slot that is not primary is a window', () => {
    expect(slotRole(0, 1, false)).toBe('window');
  });
});
