import { describe, expect, test } from 'vitest';
import { parseSeriesInfo, parseVodInfo } from '../src/xtream/vod.ts';

describe('subtitles the source lists (get_vod_info / get_series_info → info.subtitles)', () => {
  test('movie: absolute http(s) links with their language and label; anything else is left out', () => {
    const d = parseVodInfo({
      info: {
        subtitles: [
          { id: 1, title: 'English', language: 'eng', url: 'http://panel.test/subtitle/1.vtt' },
          { label: 'Svenska', lang: 'sv', file: 'https://panel.test/s/2.srt' },
          { name: 'Untagged', link: 'http://panel.test/s/3.srt' },
          { title: 'Relative', language: 'en', url: '/subtitle/4.srt' },
          { title: 'No link', language: 'en' },
          { title: 'Other scheme', url: 'ftp://panel.test/5.srt' },
          'junk',
        ],
      },
    });
    expect(d.subtitles).toEqual([
      { url: 'http://panel.test/subtitle/1.vtt', language: 'en', label: 'English' },
      { url: 'https://panel.test/s/2.srt', language: 'sv', label: 'Svenska' },
      { url: 'http://panel.test/s/3.srt', label: 'Untagged' },
    ]);
  });

  test('none listed, or not a list: no subtitles field', () => {
    expect(parseVodInfo({ info: {} }).subtitles).toBeUndefined();
    expect(parseVodInfo({ info: { subtitles: 'x' } }).subtitles).toBeUndefined();
    expect(parseVodInfo({ info: { subtitles: [] } }).subtitles).toBeUndefined();
  });

  test('at most 20 per title', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ language: 'en', url: `http://panel.test/${i}.srt` }));
    expect(parseVodInfo({ info: { subtitles: many } }).subtitles).toHaveLength(20);
  });

  test('episode: its own info.subtitles', () => {
    const d = parseSeriesInfo({
      episodes: { 1: [{ id: '7', episode_num: 1, title: 'A', info: { subtitles: [{ language: 'fre', url: 'http://panel.test/e7.srt' }] } }] },
    }, 's');
    expect(d.seasons[0]!.episodes[0]!.subtitles).toEqual([{ url: 'http://panel.test/e7.srt', language: 'fr' }]);
  });
});
