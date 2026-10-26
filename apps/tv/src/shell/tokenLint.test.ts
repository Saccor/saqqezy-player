// apps/tv/src/shell/tokenLint.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { TOKEN_KINDS, countTokens, scanTokens, type Baseline } from './tokenLint.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const only = (text: string) => Object.fromEntries(Object.entries(countTokens(text)).filter(([, v]) => v > 0));

describe('tokenLint: design literals', () => {
  test('counts colour, fontSize and focus-scale literals', () => {
    const src = 'color={0x1b2436ff} x={0x10} fontSize={30} fontSize={TYPE.body} scale={lit() ? 1.08 : 1} scale={FOCUS.scale}';
    expect(only(src)).toEqual({ colour: 1, fontSize: 1, scale: 1 });
  });
  test('counts numeric literals inside a fontSize expression, not token names', () => {
    expect(countTokens('fontSize={a ? 36 : TYPE.title} fontSize={b ? TYPE.h2 : TYPE.meta}').fontSize).toBe(1);
    expect(countTokens('fontSize={a ? 20 : 36}').fontSize).toBe(2);
  });
  test('counts a SCREAMING constant inside fontSize, borderRadius and lineHeight (a literal one step removed)', () => {
    expect(only('fontSize={NAME_SIZE} fontSize={size()} fontSize={props.fontSize}')).toEqual({ fontSize: 1 });
    expect(only('borderRadius={CELL_R} lineHeight={PLOT_LINE_H}')).toEqual({ radius: 1, lineHeight: 1 });
  });
  test('counts object-form fontSize and scale literals', () => {
    expect(only("{ fontFamily: 'sans-serif', fontSize: 32 }")).toEqual({ fontSize: 1 });
    expect(only('{ fontSize: TYPE.body, scale: FOCUS.scale }')).toEqual({});
    expect(only('{ scale: 1.08 } { scale: 1 }')).toEqual({ scale: 1 });
  });
  test('counts radius, border width, lineHeight and alpha literals', () => {
    expect(only('borderRadius={18} borderRadius={RADIUS.card} borderRadius: 6')).toEqual({ radius: 2 });
    expect(only('border={{ width: 2, color: COLORS.muted }} border={{ width: 0, color: COLORS.transparent }}')).toEqual({ border: 1 });
    expect(only('lineHeight={32} lineHeight={LINE.body}')).toEqual({ lineHeight: 1 });
    expect(only('alpha={d ? 0.5 : 1} alpha={0} alpha={ALPHA.dimmed} { alpha: 0.7 }')).toEqual({ alpha: 2 });
  });
  test('a pill radius is computed layout: h / 2 and RADIUS.pill(h) are allowed; a token times a number is too', () => {
    expect(only('borderRadius={RADIUS.pill(BADGE_H)} borderRadius={LAYOUT.gap * 2}')).toEqual({});
    expect(only('borderRadius={BADGE_H / 2}')).toEqual({ radius: 1 });
  });
  test('counts x/y/gap literals outside SPACE (0, 8, 16, 24, 48); operands of / and * are computed layout', () => {
    expect(only('x={24} y={48} gap={8} x={0}')).toEqual({});
    expect(only('x={32} gap={12} y={(H - TYPE.body) / 2 - 4}')).toEqual({ space: 3 });
    expect(only('x={i * 84} y={STEP * 3} x={w / 2}')).toEqual({});
  });
  test('counts local padding/gap/margin/inset constants set off the scale', () => {
    expect(only('const PAD = 32; const ROW_GAP = 24; const REVEAL_INSET = 14; const ITEM_H = 72;')).toEqual({ space: 2 });
  });
  test('time constants that happen to say GAP or MARGIN are not spacing', () => {
    expect(only('export const HOLD_GAP_MS = 600; const SEEK_END_MARGIN_S = 1;')).toEqual({});
  });
});

describe('tokenLint: UI strings', () => {
  test('counts text props, JSX text, text keys, toasts and sentence-like literals', () => {
    expect(only(`<Text>{'Phone'}</Text>`)).toEqual({ string: 1 });
    expect(only('<Text fontSize={TYPE.meta}>Offline</Text>')).toEqual({ string: 1 });
    expect(only('label="Add source" title={\'Versions\'} hint="Ok picks · Back closes"')).toEqual({ string: 3 });
    expect(only("{ label: 'Audio', id: 'audio' }")).toEqual({ string: 1 });
    expect(only("showToast('Saved')")).toEqual({ string: 1 });
    expect(only("const A = \"Couldn't load the sources.\";")).toEqual({ string: 1 });
  });
  test('skips identifiers, logs, thrown errors and comments', () => {
    expect(only("const B = 'sans-serif'; const id = 'audio';")).toEqual({});
    expect(only("console.warn('Poster action failed');")).toEqual({});
    expect(only("throw new Error('Not ready yet');")).toEqual({});
    expect(only("// 'This is a comment'\n/** \"Equal size\": 4 tiles */")).toEqual({});
    expect(only("const u = 'http://x'; // trailing words here")).toEqual({});
  });
});

describe('tokenLint: baseline', () => {
  test('every baseline entry uses known kinds and positive counts', () => {
    const baseline = JSON.parse(readFileSync(join(here, 'tokenLint.baseline.json'), 'utf8')) as Baseline;
    for (const [file, c] of Object.entries(baseline)) {
      for (const [k, v] of Object.entries(c)) {
        expect((TOKEN_KINDS as readonly string[]).includes(k), `${file}: ${k}`).toBe(true);
        expect(v, `${file}: ${k}`).toBeGreaterThan(0);
      }
    }
  });
  test('no file gains literals over the baseline', () => {
    const baseline = JSON.parse(readFileSync(join(here, 'tokenLint.baseline.json'), 'utf8')) as Baseline;
    const over: string[] = [];
    for (const [file, c] of Object.entries(scanTokens(SRC))) {
      for (const k of TOKEN_KINDS) {
        const now = c[k] ?? 0;
        const allowed = baseline[file]?.[k] ?? 0;
        if (now > allowed) over.push(`${file}: ${k} ${now} > ${allowed}`);
      }
    }
    expect(over, 'Use the tokens in shell/theme.ts and the strings in copy.ts').toEqual([]);
  });
  test('phase 1 is done: only worker.ts is left, and phase 0b owns it (spec 2026-10-26 §1.5)', () => {
    const left = { 'worker.ts': { string: 1 } };
    expect(JSON.parse(readFileSync(join(here, 'tokenLint.baseline.json'), 'utf8'))).toEqual(left);
    expect(scanTokens(SRC)).toEqual(left);
  });
});
