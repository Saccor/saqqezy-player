/**
 * Pure model of the on-screen keyboard (layouts, cursor movement, editing). Unit-tested; `Keyboard.tsx` only
 * draws it. Positions are in key units: the full layout is 10 units wide, the compact search layout 6.
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

export type KeyRows = readonly (readonly KeyCell[])[];

/**
 * Full layout (URLs, names, User-Agent strings): shortcuts, digits, QWERTY letters, URL symbols, more symbols, then
 * Shift/Space/⌫/Done.
 */
export const FULL_ROWS: KeyRows = [
  SHORTCUTS.map((text, i) => ({ def: { kind: 'text', text }, x: i * 2, w: 2 })),
  chars('1234567890', 0),
  chars('qwertyuiop', 0),
  chars('asdfghjkl', 0.5),
  chars('zxcvbnm', 1.5),
  chars('.:/-_@?=&', 0.5),
  chars('();,+!*~%#', 0),
  [
    { def: { kind: 'shift' }, x: 0, w: 2 },
    { def: { kind: 'space' }, x: 2, w: 4 },
    { def: { kind: 'backspace' }, x: 6, w: 2 },
    { def: { kind: 'done' }, x: 8, w: 2 },
  ],
];

/**
 * Compact search layout (Home's search bar), 6 units wide: letters in alphabetical rows of six, the digits, then
 * Space, ⌫ and Done. No Shift and no symbols: search matching ignores case and punctuation (`searchKey`).
 */
export const COMPACT_ROWS: KeyRows = [
  chars('abcdef', 0),
  chars('ghijkl', 0),
  chars('mnopqr', 0),
  chars('stuvwx', 0),
  chars('yz', 0),
  chars('123456', 0),
  chars('7890', 1),
  [
    { def: { kind: 'space' }, x: 0, w: 2 },
    { def: { kind: 'backspace' }, x: 2, w: 2 },
    { def: { kind: 'done' }, x: 4, w: 2 },
  ],
];

/** A layout's keys plus how `Keyboard.tsx` draws them (design px). */
export interface KeyboardLayout {
  rows: KeyRows;
  /** Where the cursor starts when the keyboard opens. */
  start: Cursor;
  /** Panel size. */
  width: number;
  height: number;
  /** Inner margin, and the y of the first key row. */
  pad: number;
  keysY: number;
  /** One key unit, the gap between keys, the key height and the row pitch. */
  unit: number;
  keyGap: number;
  keyH: number;
  rowStep: number;
  /** Label, value field and footer hint. The compact layout leaves them to its owner (Home's search bar). */
  chrome: boolean;
}

export const FULL_LAYOUT: KeyboardLayout = {
  rows: FULL_ROWS, start: { row: 2, col: 0 }, width: 792, height: 820,
  // Eight rows in the same panel: 62 px keys every 72 px (still large remote targets, 10 px apart).
  pad: 36, keysY: 176, unit: 72, keyGap: 8, keyH: 62, rowStep: 72, chrome: true,
};

/** 6 units of 60 px plus 10 px margins: 380 px, the width of Home's groups column. Keys are 54 x 56 px. */
export const COMPACT_LAYOUT: KeyboardLayout = {
  rows: COMPACT_ROWS, start: { row: 0, col: 0 }, width: 380, height: 524,
  pad: 10, keysY: 10, unit: 60, keyGap: 6, keyH: 56, rowStep: 64, chrome: false,
};

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

export function findKey(kind: KeyDef['kind'], rows: KeyRows = FULL_ROWS): Cursor | undefined {
  for (let row = 0; row < rows.length; row++) {
    const col = (rows[row] ?? []).findIndex((c) => c.def.kind === kind);
    if (col >= 0) return { row, col };
  }
  return undefined;
}

/** Moves within a row (stopping at the ends) or to the key nearest in x on the next row up or down. */
export function moveCursor(c: Cursor, dir: Direction, rows: KeyRows = FULL_ROWS): Cursor {
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

/** The key under a point inside the keyboard panel (design px relative to the panel), or undefined for gaps and margins. */
export function keyAt(x: number, y: number, layout: KeyboardLayout): Cursor | undefined {
  for (let row = 0; row < layout.rows.length; row++) {
    const top = layout.keysY + row * layout.rowStep;
    if (y < top || y >= top + layout.keyH) continue;
    const cells = layout.rows[row] ?? [];
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col]!;
      const left = layout.pad + cell.x * layout.unit;
      if (x >= left && x < left + cell.w * layout.unit - layout.keyGap) return { row, col };
    }
  }
  return undefined;
}
