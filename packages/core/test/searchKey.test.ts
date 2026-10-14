import { describe, expect, test } from 'vitest';
import { searchKey } from '../src/text/searchKey.ts';

describe('searchKey', () => {
  test('lowercases and strips accents', () => {
    expect(searchKey('Åtta Éclair')).toBe('atta eclair');
  });
  test('folds letters that NFD does not decompose', () => {
    expect(searchKey('Ørn Æble Straße Đak Łodz')).toBe('orn aeble strasse dak lodz');
    expect(searchKey('øæ')).toBe('oae');
  });
  test('punctuation becomes a space; whitespace collapses; trims', () => {
    expect(searchKey('  Night-News:  Late/Edition!  ')).toBe('night news late edition');
    expect(searchKey('a\tb\nc')).toBe('a b c');
  });
  test('keeps digits and non-Latin letters', () => {
    expect(searchKey('Show 24')).toBe('show 24');
    expect(searchKey('Ночь')).toBe('ночь');
  });
  test('never contains a newline; empty for punctuation-only input', () => {
    expect(searchKey('x\n\ny')).not.toContain('\n');
    expect(searchKey(' -- ')).toBe('');
  });
});
