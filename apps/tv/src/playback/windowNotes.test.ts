import { describe, expect, it } from 'vitest';
import { createWindowNotes } from './windowNotes.ts';

describe('window notes', () => {
  it('a note stays on its window until that window opens again', () => {
    const w = createWindowNotes();
    w.note(1, { kicked: 1, at: 5 });
    expect(w.notes().get(1)).toEqual({ kicked: 1, at: 5 });
    w.clear(0);
    expect(w.notes().has(1)).toBe(true);
    w.clear(1);
    expect(w.notes().has(1)).toBe(false);
  });

  it('a displaced mark is taken once: the refusal that follows the cut', () => {
    const w = createWindowNotes();
    w.markDisplaced(1);
    expect(w.takeDisplaced(1)).toBe(true);
    expect(w.takeDisplaced(1)).toBe(false);
  });

  it('multiview leaving or entering clears every note and displaced mark (G9 decision C)', () => {
    const w = createWindowNotes();
    w.note(0, { pingPong: true, at: 1 });
    w.note(1, { escalated: true, at: 2 });
    w.markDisplaced(0);
    w.reset();
    expect(w.notes().size).toBe(0);
    expect(w.takeDisplaced(0)).toBe(false);
  });

  it('reset with nothing noted keeps the same map (no needless redraw)', () => {
    const w = createWindowNotes();
    const before = w.notes();
    w.reset();
    expect(w.notes()).toBe(before);
  });
});
