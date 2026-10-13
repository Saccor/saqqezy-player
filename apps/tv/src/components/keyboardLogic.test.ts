import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_ROWS, MAX_LENGTH, applyKey, findKey, keyLabel, moveCursor, textEntryKey, visibleTail, type KeyDef,
} from './keyboardLogic.ts';

const labels = (row: number) => (KEYBOARD_ROWS[row] ?? []).map((c) => keyLabel(c.def, false));

describe('keyboard layout', () => {
  it('has the shortcut row, digits, QWERTY letters, symbols and the action row', () => {
    expect(labels(0)).toEqual(['http://', 'https://', '.com', ':8080', '/']);
    expect(labels(1)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(labels(2).join('')).toBe('qwertyuiop');
    expect(labels(3).join('')).toBe('asdfghjkl');
    expect(labels(4).join('')).toBe('zxcvbnm');
    expect(labels(5)).toEqual(['.', ':', '/', '-', '_', '@', '?', '=', '&']);
    expect(labels(6)).toEqual(['Shift', 'Space', '⌫', 'Done']);
  });

  it('every row fits the same 10-unit width and keys do not overlap', () => {
    for (const row of KEYBOARD_ROWS) {
      let end = 0;
      for (const cell of row) {
        expect(cell.x).toBeGreaterThanOrEqual(end);
        end = cell.x + cell.w;
      }
      expect(end).toBeLessThanOrEqual(10);
    }
  });

  it('shows letters upper-case while Shift is on, other keys unchanged', () => {
    const q = KEYBOARD_ROWS[2]?.[0];
    const one = KEYBOARD_ROWS[1]?.[0];
    expect(q && keyLabel(q.def, true)).toBe('Q');
    expect(one && keyLabel(one.def, true)).toBe('1');
  });

  it('findKey locates a key by kind', () => {
    const done = findKey('done');
    expect(done && KEYBOARD_ROWS[done.row]?.[done.col]?.def.kind).toBe('done');
  });
});

describe('moveCursor', () => {
  it('moves left and right inside a row and stops at the edges', () => {
    expect(moveCursor({ row: 2, col: 0 }, 'right')).toEqual({ row: 2, col: 1 });
    expect(moveCursor({ row: 2, col: 0 }, 'left')).toEqual({ row: 2, col: 0 });
    expect(moveCursor({ row: 2, col: 9 }, 'right')).toEqual({ row: 2, col: 9 });
  });

  it('moves up and down to the key nearest in x', () => {
    // 'p' (last of qwertyuiop, centre 9.5) down to 'l' (last of asdfghjkl, centre 9.0)
    expect(moveCursor({ row: 2, col: 9 }, 'down')).toEqual({ row: 3, col: 8 });
    // '1' (centre 0.5) up to 'http://' (x 0..2)
    expect(moveCursor({ row: 1, col: 0 }, 'up')).toEqual({ row: 0, col: 0 });
    // '0' (centre 9.5) up to '/' (x 8..10)
    expect(moveCursor({ row: 1, col: 9 }, 'up')).toEqual({ row: 0, col: 4 });
    // symbols '&' (centre 9.0) down to Done (x 8..10)
    expect(moveCursor({ row: 5, col: 8 }, 'down')).toEqual({ row: 6, col: 3 });
  });

  it('stops at the top and bottom rows', () => {
    expect(moveCursor({ row: 0, col: 2 }, 'up')).toEqual({ row: 0, col: 2 });
    expect(moveCursor({ row: 6, col: 1 }, 'down')).toEqual({ row: 6, col: 1 });
  });
});

describe('applyKey', () => {
  const ch = (c: string): KeyDef => ({ kind: 'char', ch: c });

  it('appends characters, shortcuts and spaces', () => {
    let s = { value: '', shift: false };
    s = applyKey(s, { kind: 'text', text: 'http://' });
    s = applyKey(s, ch('a'));
    s = applyKey(s, { kind: 'space' });
    s = applyKey(s, ch(':'));
    expect(s).toEqual({ value: 'http://a :', shift: false, done: false });
  });

  it('Shift is one-shot and only affects letters', () => {
    let s = applyKey({ value: '', shift: false }, { kind: 'shift' });
    expect(s.shift).toBe(true);
    s = applyKey(s, ch('a'));
    expect(s).toEqual({ value: 'A', shift: false, done: false });
    s = applyKey(applyKey(s, { kind: 'shift' }), { kind: 'shift' });
    expect(s.shift).toBe(false);
  });

  it('backspace removes one whole character and is safe on empty text', () => {
    expect(applyKey({ value: 'ab😀', shift: false }, { kind: 'backspace' }).value).toBe('ab');
    expect(applyKey({ value: '', shift: false }, { kind: 'backspace' }).value).toBe('');
  });

  it('done keeps the text and reports done', () => {
    expect(applyKey({ value: 'x', shift: true }, { kind: 'done' })).toEqual({ value: 'x', shift: true, done: true });
  });

  it('never grows past MAX_LENGTH', () => {
    const full = 'a'.repeat(MAX_LENGTH);
    expect(applyKey({ value: full, shift: false }, ch('b')).value).toBe(full);
    expect(applyKey({ value: full.slice(1), shift: false }, { kind: 'text', text: 'https://' }).value.length).toBe(MAX_LENGTH);
  });
});

describe('textEntryKey (physical keyboard while editing)', () => {
  const plain = { ctrlKey: false, metaKey: false, altKey: false };

  it('passes printable characters, including digits, m, i and space', () => {
    for (const k of ['a', 'Z', '5', 'm', 'i', ' ', '@', '/', 'å']) {
      expect(textEntryKey({ key: k, ...plain })).toEqual({ kind: 'char', ch: k });
    }
  });

  it('accepts AltGr characters (Ctrl+Alt) but not Ctrl or Meta shortcuts', () => {
    expect(textEntryKey({ key: '@', ctrlKey: true, metaKey: false, altKey: true })).toEqual({ kind: 'char', ch: '@' });
    expect(textEntryKey({ key: 'v', ctrlKey: true, metaKey: false, altKey: false })).toBeUndefined();
    expect(textEntryKey({ key: 'c', ctrlKey: false, metaKey: true, altKey: false })).toBeUndefined();
  });

  it('maps Backspace to delete and leaves navigation keys alone', () => {
    expect(textEntryKey({ key: 'Backspace', ...plain })).toEqual({ kind: 'backspace' });
    for (const k of ['ArrowUp', 'Enter', 'Escape', 'F3', 'Tab', 'Shift', 'Dead']) {
      expect(textEntryKey({ key: k, ...plain })).toBeUndefined();
    }
  });
});

describe('visibleTail', () => {
  it('keeps short text and shows the end of long text behind an ellipsis', () => {
    expect(visibleTail('abc', 5)).toBe('abc');
    expect(visibleTail('abcdefgh', 5)).toBe('…efgh');
  });
});
