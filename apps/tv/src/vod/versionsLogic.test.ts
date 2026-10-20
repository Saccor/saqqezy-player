import { describe, expect, test } from 'vitest';
import type { VersionView } from '@iptv/app-api';
import {
  PREFERRED_LANGUAGE_OPTIONS, SHOW_SEPARATELY, preferredLanguageLabel, preferredLanguageOption, preferredLanguagesFor, versionLabel, versionRows,
} from './versionsLogic.ts';

const v = (id: string, lang?: string, quality?: string, tags: string[] = [], auto = false): VersionView => {
  const out: VersionView = { id, tags, auto };
  if (lang) out.lang = lang;
  if (quality) out.quality = quality;
  return out;
};

describe('versionLabel', () => {
  test('language name, quality and tags', () => {
    expect(versionLabel(v('a', 'sv', '4K', ['HDR']))).toBe('Swedish · 4K · HDR');
    expect(versionLabel(v('a', 'en', 'HD'))).toBe('English · HD');
  });
  test('no language detected', () => {
    expect(versionLabel(v('a', undefined, 'FHD'))).toBe('Unknown language · FHD');
    expect(versionLabel(v('a'))).toBe('Unknown language');
  });
  test('the automatic pick is marked', () => {
    expect(versionLabel(v('a', 'da', undefined, [], true))).toBe('Danish · Auto');
  });
  test('an unknown code shows upper case', () => {
    expect(versionLabel(v('a', 'xx'))).toBe('XX');
  });
});

describe('versionRows', () => {
  test('one row per version, the shown one checked, then Show separately', () => {
    const rows = versionRows([v('a', 'sv', undefined, [], true), v('b', 'en')], 'b');
    expect(rows).toEqual([
      { kind: 'list', id: 'a', label: 'Swedish · Auto', checked: false },
      { kind: 'list', id: 'b', label: 'English', checked: true },
      { kind: 'new', label: SHOW_SEPARATELY },
    ]);
  });
});

describe('preferred language stepper', () => {
  test('Automatic first, no Off', () => {
    expect(PREFERRED_LANGUAGE_OPTIONS[0]).toBe('auto');
    expect(PREFERRED_LANGUAGE_OPTIONS).not.toContain('off');
    expect(PREFERRED_LANGUAGE_OPTIONS).toContain('sv');
  });
  test('maps to and from the stored list', () => {
    expect(preferredLanguageOption([])).toBe('auto');
    expect(preferredLanguageOption(['sv', 'en'])).toBe('sv');
    expect(preferredLanguagesFor('auto')).toEqual([]);
    expect(preferredLanguagesFor('da')).toEqual(['da']);
  });
  test('labels', () => {
    expect(preferredLanguageLabel('auto')).toBe('Automatic (TV language)');
    expect(preferredLanguageLabel('sv')).toBe('Swedish');
  });
});
