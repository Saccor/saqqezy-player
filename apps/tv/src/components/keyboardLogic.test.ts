import { describe, expect, it } from 'vitest';
import {
  COMPACT_LAYOUT, COMPACT_ROWS, FULL_LAYOUT, FULL_ROWS, MAX_LENGTH, applyKey, findKey, keyLabel, moveCursor, textEntryKey,
  visibleTail, keyAt, type KeyDef, type KeyRows,
} from './keyboardLogic.ts';

const labels = (row: number) => (FULL_ROWS[row] ?? []).map((c) => keyLabel(c.def, false));

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
    for (const row of FULL_ROWS) {
      let end = 0;
      for (const cell of row) {
        expect(cell.x).toBeGreaterThanOrEqual(end);
        end = cell.x + cell.w;
      }
      expect(end).toBeLessThanOrEqual(10);
    }
  });

  it('shows letters upper-case while Shift is on, other keys unchanged', () => {
    const q = FULL_ROWS[2]?.[0];
    const one = FULL_ROWS[1]?.[0];
    expect(q && keyLabel(q.def, true)).toBe('Q');
    expect(one && keyLabel(one.def, true)).toBe('1');
  });

  it('findKey locates a key by kind', () => {
    const done = findKey('done');
    expect(done && FULL_ROWS[done.row]?.[done.col]?.def.kind).toBe('done');
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

describe('layouts', () => {
  const unitsWide = (rows: KeyRows) => Math.max(...rows.map((row) => row.reduce((end, c) => Math.max(end, c.x + c.w), 0)));

  it('the full layout keeps its keys, size and start key', () => {
    expect(FULL_LAYOUT.rows).toBe(FULL_ROWS);
    expect([FULL_LAYOUT.width, FULL_LAYOUT.height]).toEqual([792, 820]);
    expect(FULL_LAYOUT.start).toEqual({ row: 2, col: 0 });
    expect(FULL_LAYOUT.chrome).toBe(true);
    expect(unitsWide(FULL_ROWS)).toBe(10);
  });

  it('every key lies inside its panel, clear of the margins and the footer', () => {
    for (const L of [FULL_LAYOUT, COMPACT_LAYOUT]) {
      const bottomLimit = L.chrome ? L.height - 56 : L.height - L.pad;
      L.rows.forEach((row, r) => {
        for (const cell of row) {
          expect(L.pad + cell.x * L.unit).toBeGreaterThanOrEqual(L.pad);
          expect(L.pad + (cell.x + cell.w) * L.unit - L.keyGap).toBeLessThanOrEqual(L.width - L.pad);
          expect(L.keysY + r * L.rowStep + L.keyH).toBeLessThanOrEqual(bottomLimit);
        }
      });
    }
  });
});

describe('compact layout', () => {
  const labelsOf = (row: number) => (COMPACT_ROWS[row] ?? []).map((c) => keyLabel(c.def, false));

  it('has letters in alphabetical rows of six, the digits, then Space, ⌫ and Done', () => {
    expect(COMPACT_ROWS.map((_, r) => labelsOf(r).join(' '))).toEqual([
      'a b c d e f', 'g h i j k l', 'm n o p q r', 's t u v w x', 'y z', '1 2 3 4 5 6', '7 8 9 0', 'Space ⌫ Done',
    ]);
  });

  it('is at most 6 units wide, keys do not overlap, and there is no Shift', () => {
    for (const row of COMPACT_ROWS) {
      let end = 0;
      for (const cell of row) {
        expect(cell.x).toBeGreaterThanOrEqual(end);
        end = cell.x + cell.w;
      }
      expect(end).toBeLessThanOrEqual(6);
    }
    expect(findKey('shift', COMPACT_ROWS)).toBeUndefined();
  });

  it('starts on "a" and finds its action keys', () => {
    const s = COMPACT_LAYOUT.start;
    expect(keyLabel(COMPACT_ROWS[s.row]![s.col]!.def, false)).toBe('a');
    expect(findKey('space', COMPACT_ROWS)).toEqual({ row: 7, col: 0 });
    expect(findKey('done', COMPACT_ROWS)).toEqual({ row: 7, col: 2 });
  });

  it('stops at the edges (Home uses the stops to leave the keyboard)', () => {
    expect(moveCursor({ row: 0, col: 5 }, 'right', COMPACT_ROWS)).toEqual({ row: 0, col: 5 });
    expect(moveCursor({ row: 4, col: 1 }, 'right', COMPACT_ROWS)).toEqual({ row: 4, col: 1 });
    expect(moveCursor({ row: 0, col: 2 }, 'up', COMPACT_ROWS)).toEqual({ row: 0, col: 2 });
    expect(moveCursor({ row: 7, col: 1 }, 'down', COMPACT_ROWS)).toEqual({ row: 7, col: 1 });
  });

  it('moves up and down to the key nearest in x', () => {
    expect(moveCursor({ row: 0, col: 5 }, 'down', COMPACT_ROWS)).toEqual({ row: 1, col: 5 }); // f -> l
    expect(moveCursor({ row: 3, col: 5 }, 'down', COMPACT_ROWS)).toEqual({ row: 4, col: 1 }); // x -> z
    expect(moveCursor({ row: 4, col: 1 }, 'down', COMPACT_ROWS)).toEqual({ row: 5, col: 1 }); // z -> 2
    expect(moveCursor({ row: 5, col: 5 }, 'down', COMPACT_ROWS)).toEqual({ row: 6, col: 3 }); // 6 -> 0
    expect(moveCursor({ row: 6, col: 3 }, 'down', COMPACT_ROWS)).toEqual({ row: 7, col: 2 }); // 0 -> Done
    expect(moveCursor({ row: 6, col: 0 }, 'down', COMPACT_ROWS)).toEqual({ row: 7, col: 0 }); // 7 -> Space
  });

  it('Space, ⌫ and Done edit through applyKey', () => {
    const at = (row: number, col: number) => COMPACT_ROWS[row]![col]!.def;
    let s = { value: '', shift: false };
    for (const [r, c] of [[0, 0], [0, 1], [7, 0], [5, 0]] as const) s = applyKey(s, at(r, c));
    expect(s.value).toBe('ab 1');
    s = applyKey(s, at(7, 1));
    expect(s.value).toBe('ab ');
    expect(applyKey(s, at(7, 2))).toEqual({ value: 'ab ', shift: false, done: true });
  });
});

describe('keyAt (pointer)', () => {
  it('finds compact keys and skips the gaps between them', () => {
    // pad 10, keysY 10, unit 60, keyGap 6, keyH 56, rowStep 64
    expect(keyAt(10, 10, COMPACT_LAYOUT)).toEqual({ row: 0, col: 0 });
    expect(keyAt(63.9, 65.9, COMPACT_LAYOUT)).toEqual({ row: 0, col: 0 });
    expect(keyAt(64, 20, COMPACT_LAYOUT)).toBeUndefined();
    expect(keyAt(70, 20, COMPACT_LAYOUT)).toEqual({ row: 0, col: 1 });
    expect(keyAt(20, 66, COMPACT_LAYOUT)).toBeUndefined();
    expect(keyAt(20, 74, COMPACT_LAYOUT)).toEqual({ row: 1, col: 0 });
  });

  it('honours key offsets and widths (the digit row and Space, ⌫, Done)', () => {
    const digitsY = 10 + 6 * 64 + 5;
    expect(keyAt(20, digitsY, COMPACT_LAYOUT)).toBeUndefined();
    expect(keyAt(75, digitsY, COMPACT_LAYOUT)).toEqual({ row: 6, col: 0 });
    const actionsY = 10 + 7 * 64 + 2;
    expect(keyAt(100, actionsY, COMPACT_LAYOUT)).toEqual({ row: 7, col: 0 });
    expect(keyAt(130, actionsY, COMPACT_LAYOUT)).toEqual({ row: 7, col: 1 });
  });

  it('is undefined in the margins and outside the panel', () => {
    expect(keyAt(5, 5, COMPACT_LAYOUT)).toBeUndefined();
    expect(keyAt(400, 20, COMPACT_LAYOUT)).toBeUndefined();
    expect(keyAt(20, 600, COMPACT_LAYOUT)).toBeUndefined();
  });

  it('works on the full layout below its label and value field', () => {
    // pad 36, keysY 176, unit 72, keyGap 8: the first shortcut key spans x 36..172
    expect(keyAt(36, 176, FULL_LAYOUT)).toEqual({ row: 0, col: 0 });
    expect(keyAt(171, 180, FULL_LAYOUT)).toEqual({ row: 0, col: 0 });
    expect(keyAt(172, 180, FULL_LAYOUT)).toBeUndefined();
    expect(keyAt(180, 180, FULL_LAYOUT)).toEqual({ row: 0, col: 1 });
    expect(keyAt(100, 100, FULL_LAYOUT)).toBeUndefined();
  });
});
