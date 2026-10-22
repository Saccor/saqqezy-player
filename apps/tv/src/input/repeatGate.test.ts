import { describe, expect, it } from 'vitest';
import { createRepeatGate } from './repeatGate.ts';

describe('createRepeatGate', () => {
  it('always lets the first press through, even right after another key', () => {
    const gate = createRepeatGate(80);
    expect(gate.down('Right', 0)).toBe(true);
    gate.up('Right');
    expect(gate.down('Right', 10)).toBe(true);
    expect(gate.down('Down', 20)).toBe(true);
  });

  it('lets a held repeat through at the normal pace, and drops a queued burst', () => {
    const gate = createRepeatGate(80);
    expect(gate.down('Right', 0)).toBe(true);
    expect(gate.down('Right', 100)).toBe(true);
    // A slow step: three repeats were queued and arrive back to back; only the first moves focus.
    expect(gate.down('Right', 400)).toBe(true);
    expect(gate.down('Right', 401)).toBe(false);
    expect(gate.down('Right', 402)).toBe(false);
    expect(gate.down('Right', 480)).toBe(true);
  });

  it('a blur releases every key', () => {
    const gate = createRepeatGate(80);
    gate.down('Up', 0);
    gate.up();
    expect(gate.down('Up', 5)).toBe(true);
  });
});
