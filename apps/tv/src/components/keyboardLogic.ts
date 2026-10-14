/**
 * Pure model of the on-screen keyboard (layout, cursor movement, editing). Unit-tested; `Keyboard.tsx` only
 * draws it. Positions are in key units: every row is at most 10 units wide.
 */

export type KeyDef =
  | { kind: 'char'; ch: string }
  | { kind: 'text'; text: string }
  | { kind: 'shift' }
  | { kind: 'space' }
  | { kind: 'backspace' }
  | { kind: 'done' };

export interface KeyCell { def: KeyDef; x: number; w: number }
export interface Cursor { row: number; col: number }
export type Direction = 'up' | 'down' | 'left' | 'right';

/** Longest text a field accepts (URLs with long query strings fit comfortably). */
export const MAX_LENGTH = 2048;

const chars = (s: string, offset: number): KeyCell[] =>
  [...s].map((ch, i) => ({ def: { kind: 'char', ch }, x: offset + i, w: 1 }));

export const SHORTCUTS = ['http://', 'https://', '.com', ':8080', '/'] as const;

export const KEYBOARD_ROWS: readonly (readonly KeyCell[])[] = [
  SHORTCUTS.map((text, i) => ({ def: { kind: 'text', text }, x: i * 2, w: 2 })),
  chars('1234567890', 0),
  chars('qwertyuiop', 0),
  chars('asdfghjkl', 0.5),
  chars('zxcvbnm', 1.5),
  chars('.:/-_@?=&', 0.5),
  [
    { def: { kind: 'shift' }, x: 0, w: 2 },
    { def: { kind: 'space' }, x: 2, w: 4 },
    { def: { kind: 'backspace' }, x: 6, w: 2 },
    { def: { kind: 'done' }, x: 8, w: 2 },
  ],
];

/** Where the cursor starts when the keyboard opens: the first letter. */
export const START_CURSOR: Cursor = { row: 2, col: 0 };

const isLetter = (ch: string) => ch.toLowerCase() !== ch.toUpperCase();

export function keyLabel(def: KeyDef, shift: boolean): string {
  switch (def.kind) {
    case 'char': return shift && isLetter(def.ch) ? def.ch.toUpperCase() : def.ch;
    case 'text': return def.text;
    case 'shift': return 'Shift';
    case 'space': return 'Space';
    case 'backspace': return '⌫';
    case 'done': return 'Done';
  }
}

export function findKey(kind: KeyDef['kind']): Cursor | undefined {
  for (let row = 0; row < KEYBOARD_ROWS.length; row++) {
    const col = (KEYBOARD_ROWS[row] ?? []).findIndex((c) => c.def.kind === kind);
    if (col >= 0) return { row, col };
  }
  return undefined;
}

/** Moves within a row (stopping at the ends) or to the key nearest in x on the next row up or down. */
export function moveCursor(c: Cursor, dir: Direction, rows: readonly (readonly KeyCell[])[] = KEYBOARD_ROWS): Cursor {
  const row = rows[c.row];
  if (!row) return c;
  if (dir === 'left') return { row: c.row, col: Math.max(0, c.col - 1) };
  if (dir === 'right') return { row: c.row, col: Math.min(row.length - 1, c.col + 1) };
  const nextRow = c.row + (dir === 'up' ? -1 : 1);
  const target = rows[nextRow];
  const cell = row[c.col];
  if (!target || target.length === 0 || !cell) return c;
  const centre = cell.x + cell.w / 2;
  let best = 0;
  let bestDist = Infinity;
  target.forEach((t, i) => {
    const d = Math.abs(t.x + t.w / 2 - centre);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return { row: nextRow, col: best };
}

export interface EditState { value: string; shift: boolean }

const append = (value: string, add: string): string => {
  const room = MAX_LENGTH - value.length;
  return room <= 0 ? value : value + add.slice(0, room);
};

/** Applies one key. Shift is one-shot: it upper-cases the next letter, then turns off. */
export function applyKey(s: EditState, def: KeyDef): EditState & { done: boolean } {
  switch (def.kind) {
    case 'char': {
      const ch = s.shift && isLetter(def.ch) ? def.ch.toUpperCase() : def.ch;
      return { value: append(s.value, ch), shift: false, done: false };
    }
    case 'text': return { value: append(s.value, def.text), shift: s.shift, done: false };
    case 'space': return { value: append(s.value, ' '), shift: s.shift, done: false };
    case 'backspace': return { value: Array.from(s.value).slice(0, -1).join(''), shift: s.shift, done: false };
    case 'shift': return { value: s.value, shift: !s.shift, done: false };
    case 'done': return { value: s.value, shift: s.shift, done: true };
  }
}

export type TextKey = { kind: 'char'; ch: string } | { kind: 'backspace' };

/**
 * Physical keyboard input while a field is being edited: printable characters (AltGr counts, Ctrl/Meta
 * shortcuts do not) and Backspace. Everything else (arrows, Enter, Escape, colour keys) stays a remote key.
 */
export function textEntryKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): TextKey | undefined {
  if (e.key === 'Backspace') return { kind: 'backspace' };
  if (e.metaKey || (e.ctrlKey && !e.altKey)) return undefined;
  if (Array.from(e.key).length !== 1) return undefined;
  return { kind: 'char', ch: e.key };
}

/** Fits text into `max` characters for display by keeping its end (where typing happens) behind an ellipsis. */
export function visibleTail(s: string, max: number): string {
  const cs = Array.from(s);
  return cs.length <= max ? s : `…${cs.slice(cs.length - (max - 1)).join('')}`;
}
