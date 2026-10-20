import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { countTokens, scanTokens, type TokenCounts } from './tokenLint.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');

describe('tokenLint', () => {
  test('counts colour, fontSize and focus-scale literals', () => {
    const src = 'color={0x1b2436ff} x={0x10} fontSize={30} fontSize={TYPE.body} scale={lit() ? 1.08 : 1} scale={FOCUS.scale}';
    expect(countTokens(src)).toEqual({ colour: 1, fontSize: 1, scale: 1 });
  });
  test('counts numeric literals inside a fontSize expression, not token names', () => {
    expect(countTokens('fontSize={a ? 36 : TYPE.title} fontSize={b ? TYPE.h2 : TYPE.meta}').fontSize).toBe(1);
    expect(countTokens('fontSize={a ? 20 : 36}').fontSize).toBe(2);
  });
  test('the baseline is empty: every file uses the tokens', () => {
    expect(JSON.parse(readFileSync(join(here, 'tokenLint.baseline.json'), 'utf8'))).toEqual({});
  });
  test('no file gains literals over the baseline', () => {
    const baseline = JSON.parse(readFileSync(join(here, 'tokenLint.baseline.json'), 'utf8')) as Record<string, TokenCounts>;
    const over: string[] = [];
    for (const [file, c] of Object.entries(scanTokens(SRC))) {
      const b = baseline[file] ?? { colour: 0, fontSize: 0, scale: 0 };
      for (const k of ['colour', 'fontSize', 'scale'] as const) if (c[k] > b[k]) over.push(`${file}: ${k} ${c[k]} > ${b[k]}`);
    }
    expect(over, 'Use COLORS / TYPE / FOCUS from shell/theme.ts').toEqual([]);
  });
});
