import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRAST_PAIRS, contrastRatio, DARK, LIGHT, type ThemeTokens } from './tokens.ts';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** The `--name: #hex` declarations of the first `:root { … }` block found after `from`. */
function rootVars(fromIndex: number): Record<string, string> {
  const start = css.indexOf(':root', fromIndex);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

const themes: [string, ThemeTokens, Record<string, string>][] = [
  ['dark', DARK, rootVars(0)],
  ['light', LIGHT, rootVars(css.indexOf('@media (prefers-color-scheme: light)'))],
];

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

describe.each(themes)('%s theme tokens', (_name, tokens, cssVars) => {
  it('styles.css declares the same colours as tokens.ts', () => {
    for (const [key, value] of Object.entries(tokens)) {
      expect(cssVars[key], `--${key}`).toBe(value);
    }
  });

  it.each(CONTRAST_PAIRS)('%s on %s has at least %d:1 contrast', (fg, bg, min) => {
    expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min);
  });
});
