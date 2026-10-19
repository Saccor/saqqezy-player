import { describe, expect, test } from 'vitest';
import { baseOf, peelPrefix, stripTags, tidy } from '../src/text/nameTags.ts';

describe('nameTags', () => {
  test('peelPrefix returns the raw code and the language', () => {
    expect(peelPrefix('UK: Channel One')).toMatchObject({ code: 'UK', lang: 'en', rest: 'Channel One' });
    expect(peelPrefix('|SE| Channel One')).toMatchObject({ code: 'SE', lang: 'sv' });
    expect(peelPrefix('4K-EN Channel One')).toMatchObject({ code: 'EN', quality: 0 });
    expect(peelPrefix('UP - Channel One')).toBeUndefined();
  });
  test('stripTags and tidy', () => {
    const t = stripTags('Channel One FHD HEVC');
    expect(t.quality).toBe(1);
    expect(tidy(t.rest)).toBe('Channel One');
  });
  test('baseOf folds case and punctuation', () => {
    expect(baseOf('Channel One & Two')).toBe('channel one and two');
  });
});
