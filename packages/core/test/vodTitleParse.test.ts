import { describe, expect, test } from 'vitest';
import { categoryBase, parseVodTitle, QUALITY_UNKNOWN } from '../src/vod/titleParse.ts';

describe('parseVodTitle: language prefixes', () => {
  test('"EN - Title (year) 4K"', () => {
    expect(parseVodTitle('EN - Synthetic Film (2021) 4K')).toEqual({
      display: 'Synthetic Film', base: 'synthetic film', year: 2021, lang: 'en', quality: 0, tags: [],
    });
  });
  test('"|SE| Title year FHD"', () => {
    expect(parseVodTitle('|SE| Synthetic Film 2021 FHD')).toMatchObject({ base: 'synthetic film', year: 2021, lang: 'sv', quality: 1 });
  });
  test('"[DK] Title [MULTI-SUB]"', () => {
    const p = parseVodTitle('[DK] Synthetic Film [MULTI-SUB]');
    expect(p).toMatchObject({ display: 'Synthetic Film', lang: 'da', tags: ['MULTI'] });
    expect(p.year).toBeUndefined();
  });
  test('box-drawing bars and superscript quality', () => {
    expect(parseVodTitle('┃EN┃ Synthetic Film ᴴᴰ')).toMatchObject({ display: 'Synthetic Film', lang: 'en', quality: 2 });
  });
  test('"4K-EN" and "EN 4K:" prefixes', () => {
    expect(parseVodTitle('4K-EN Synthetic Film')).toMatchObject({ display: 'Synthetic Film', lang: 'en', quality: 0 });
    expect(parseVodTitle('EN 4K: Synthetic Film')).toMatchObject({ display: 'Synthetic Film', lang: 'en', quality: 0 });
  });
  test('"EN:" and "(SE)" prefixes', () => {
    expect(parseVodTitle('EN: Synthetic Film')).toMatchObject({ display: 'Synthetic Film', lang: 'en' });
    expect(parseVodTitle('(SE) Synthetic Film')).toMatchObject({ display: 'Synthetic Film', lang: 'sv' });
  });
  test('a word that is not a known code is not a prefix', () => {
    const p = parseVodTitle('UP - Synthetic Film');
    expect(p.display).toBe('UP - Synthetic Film');
    expect(p.lang).toBeUndefined();
  });
  test('no prefix in the title: the category prefix gives the language', () => {
    expect(parseVodTitle('Synthetic Film', 'SE | Action').lang).toBe('sv');
    expect(parseVodTitle('Synthetic Film', 'Action').lang).toBeUndefined();
  });
  test('the title prefix wins over the category', () => {
    expect(parseVodTitle('EN - Synthetic Film', 'SE | Action').lang).toBe('en');
  });
});

describe('parseVodTitle: base, numbers and years', () => {
  test('roman numerals become digits; digits stay', () => {
    expect(parseVodTitle('Synthetic Film II (2019)')).toMatchObject({ base: 'synthetic film 2', year: 2019 });
    expect(parseVodTitle('Synthetic Film 2').base).toBe('synthetic film 2');
    expect(parseVodTitle('Synthetic Film').base).toBe('synthetic film');
  });
  test('a title that is a number keeps it', () => {
    const p = parseVodTitle('1917');
    expect(p).toMatchObject({ display: '1917', base: '1917' });
    expect(p.year).toBeUndefined();
    expect(parseVodTitle('1917 (2019)')).toMatchObject({ base: '1917', year: 2019 });
  });
  test('"- year" and "[year]" forms', () => {
    expect(parseVodTitle('Synthetic Film - 2005')).toMatchObject({ display: 'Synthetic Film', year: 2005 });
    expect(parseVodTitle('Synthetic Film [2005] HD')).toMatchObject({ display: 'Synthetic Film', year: 2005, quality: 2 });
  });
  test('codec and HDR tags', () => {
    expect(parseVodTitle('Example Story HEVC HDR 2160p')).toMatchObject({ display: 'Example Story', quality: 0, tags: ['HDR', 'HEVC'] });
  });
  test('& folds to "and"', () => {
    expect(parseVodTitle('Synthetic Film & Friends').base).toBe('synthetic film and friends');
  });
  test('nothing left after stripping keeps the raw title', () => {
    expect(parseVodTitle('EN - 4K')).toMatchObject({ display: 'EN - 4K', base: 'en 4k' });
  });
  test('no quality tag is unknown', () => {
    expect(parseVodTitle('Synthetic Film').quality).toBe(QUALITY_UNKNOWN);
  });
  test('words containing a tag are not tags', () => {
    expect(parseVodTitle('Subway Story').display).toBe('Subway Story');
    expect(parseVodTitle('The Hdtv Show').display).toBe('The Hdtv Show');
  });
});

describe('categoryBase', () => {
  test('language and quality are stripped', () => {
    expect(categoryBase('SE | Action')).toEqual({ base: 'action', display: 'Action' });
    expect(categoryBase('Action 4K')).toEqual({ base: 'action', display: 'Action' });
    expect(categoryBase('EN: ACTION')).toEqual({ base: 'action', display: 'ACTION' });
  });
  test('a category that is only a code keeps its name', () => {
    expect(categoryBase('EN')).toEqual({ base: 'en', display: 'EN' });
  });
});
