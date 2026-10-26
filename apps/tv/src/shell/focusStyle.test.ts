import { describe, expect, it } from 'vitest';
import { sheetWheel } from '../components/sheetLogic.ts';
import { drawnFocus, drawnRow, focusInit, hoverEvent, wheelFocus } from './focusStyle.ts';

describe('drawnFocus (spec 2026-10-26 §1.2: one hover style, equal to focus)', () => {
  it('draws the key selection, or the hovered item in pointer mode', () => {
    expect(drawnFocus(2, undefined, false)).toBe(2);
    expect(drawnFocus(2, 4, false)).toBe(2);
    expect(drawnFocus(2, 4, true)).toBe(4);
    expect(drawnFocus(2, undefined, true)).toBe(2);
  });
});

describe('pointer focus source (the wheel moves the drawn focus; hover takes over only when the pointer moves)', () => {
  const at = (x: number, y: number) => ({ x, y });
  it('starts with the key selection drawn', () => {
    expect(drawnRow(2, focusInit(), true)).toBe(2);
  });
  it('a pointer move onto a row draws that row', () => {
    const s = hoverEvent(focusInit(), 4, at(10, 300));
    expect(drawnRow(2, s, true)).toBe(4);
    expect(drawnRow(2, s, false)).toBe(2);
  });
  it('after a wheel step the selection is drawn, even though rehover re-reports the row under the cursor', () => {
    let s = hoverEvent(focusInit(), 4, at(10, 300));
    s = wheelFocus(s);
    expect(drawnRow(5, s, true)).toBe(5);
    s = hoverEvent(s, 4, at(10, 300)); // rehover: same point, same row
    expect(drawnRow(5, s, true)).toBe(5);
    s = hoverEvent(s, 6, at(10, 300)); // list scrolled under a still cursor: new row, same point
    expect(drawnRow(5, s, true)).toBe(5);
  });
  it('the pointer moving again hands the drawn focus back to the hovered row', () => {
    let s = wheelFocus(hoverEvent(focusInit(), 4, at(10, 300)));
    s = hoverEvent(s, 6, at(10, 380));
    expect(drawnRow(5, s, true)).toBe(6);
    s = hoverEvent(s, 6, at(12, 380)); // moved within the same row
    expect(drawnRow(5, s, true)).toBe(6);
  });
  it('leaving the sheet and coming back counts as a move', () => {
    let s = wheelFocus(hoverEvent(focusInit(), 4, at(10, 300)));
    s = hoverEvent(s, undefined, undefined);
    expect(drawnRow(5, s, true)).toBe(5);
    s = hoverEvent(s, 4, at(10, 300));
    expect(drawnRow(5, s, true)).toBe(4);
  });
  it('a wheel step starts from the drawn row', () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, label: `r${i}` }));
    const hovered = hoverEvent(focusInit(), 4, at(10, 300));
    expect(sheetWheel(1, rows, 1, hovered, true).sel).toBe(5);
    expect(sheetWheel(1, rows, -1, hovered, true).sel).toBe(3);
    const after = sheetWheel(1, rows, 1, hovered, true);
    expect(drawnRow(after.sel, after.focus, true)).toBe(5);
    expect(sheetWheel(1, rows, 1, hovered, false).sel).toBe(2);
  });
});
