import { describe, expect, test } from 'vitest';
import {
  OpenSubtitlesClient, bestSubtitle, languageChoices, searchParams, searchTitle, type OnlineSubtitle,
} from '../src/subtitles/openSubtitles.ts';
import { SubtitleError } from '../src/subtitles/service.ts';
import type { FetchFn } from '../src/types.ts';

// Synthetic answers shaped like the OpenSubtitles REST v1 API; no real titles.
const hit = (fileId: number, language: string, extra: Record<string, unknown> = {}) => ({
  id: String(fileId * 10),
  type: 'subtitle',
  attributes: {
    language, download_count: 100, hearing_impaired: false, machine_translated: false, ai_translated: false,
    from_trusted: false, release: `Synthetic.Film.${language}`, files: [{ file_id: fileId, file_name: `synthetic.${language}.srt` }],
    ...extra,
  },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sub = (fileId: number, language: string, o: Partial<OnlineSubtitle> = {}): OnlineSubtitle => ({
  fileId, language, release: `r${fileId}`, downloads: 0, hearingImpaired: false, machineTranslated: false, trusted: false, ...o,
});

describe('searchParams', () => {
  test('movie by TMDB id, keys sorted and values lower-case (the API redirects otherwise)', () => {
    expect(searchParams({ tmdbId: 123, query: 'Ignored', languages: ['sv', 'en'] })).toBe('languages=en,sv&tmdb_id=123');
  });

  test('episode by the series TMDB id plus season and episode', () => {
    expect(searchParams({ parentTmdbId: 77, season: 2, episode: 5 })).toBe('episode_number=5&parent_tmdb_id=77&season_number=2');
  });

  test('no id: the cleaned title and year (episodes add season and episode)', () => {
    expect(searchParams({ query: 'Synthetic Film', year: 2001 })).toBe('query=synthetic+film&year=2001');
    expect(searchParams({ query: 'Synthetic Show', season: 1, episode: 3 })).toBe('episode_number=3&query=synthetic+show&season_number=1');
  });
});

describe('searchTitle', () => {
  test('drops provider tags, the year and quality words; keeps the year apart', () => {
    expect(searchTitle('EN - Synthetic Film (2001) 4K')).toEqual({ title: 'Synthetic Film', year: 2001 });
    expect(searchTitle('|SE| Synthetic Film [2001]')).toEqual({ title: 'Synthetic Film', year: 2001 });
    expect(searchTitle('[MULTI] Synthetic Film 1080p HEVC')).toEqual({ title: 'Synthetic Film' });
    expect(searchTitle('NL: Synthetic Show')).toEqual({ title: 'Synthetic Show' });
    expect(searchTitle('Synthetic Film 2: The Sequel (2004)')).toEqual({ title: 'Synthetic Film 2: The Sequel', year: 2004 });
    expect(searchTitle('Dr. Synthetic')).toEqual({ title: 'Dr. Synthetic' });
    expect(searchTitle('Up: A Synthetic Tale')).toEqual({ title: 'Up: A Synthetic Tale' });
  });
});

describe('ranking and the language list', () => {
  test('best: trusted, then not machine-translated, then not hearing-impaired, then most downloaded', () => {
    expect(bestSubtitle([sub(1, 'en', { downloads: 900, machineTranslated: true }), sub(2, 'en', { downloads: 10 })])?.fileId).toBe(2);
    expect(bestSubtitle([sub(1, 'en', { downloads: 900 }), sub(2, 'en', { downloads: 5, trusted: true })])?.fileId).toBe(2);
    expect(bestSubtitle([sub(1, 'en', { downloads: 900, hearingImpaired: true }), sub(2, 'en', { downloads: 5 })])?.fileId).toBe(2);
    expect(bestSubtitle([sub(1, 'en', { downloads: 5 }), sub(2, 'en', { downloads: 50 })])?.fileId).toBe(2);
    expect(bestSubtitle([])).toBeUndefined();
  });

  test('one row per language: preferred first, then by count, then by code; each with its best file', () => {
    const list = [sub(1, 'en'), sub(2, 'en', { downloads: 9 }), sub(3, 'fr'), sub(4, 'sv'), sub(5, 'de'), sub(6, 'de')];
    expect(languageChoices(list, 'sv').map((c) => [c.language, c.count, c.best.fileId])).toEqual([
      ['sv', 1, 4], ['de', 2, 5], ['en', 2, 2], ['fr', 1, 3],
    ]);
    expect(languageChoices(list, 'off')[0]?.language).toBe('de');
    expect(languageChoices([sub(1, 'pt-BR')], 'pt').map((c) => c.language)).toEqual(['pt-BR']);
  });
});

describe('OpenSubtitlesClient', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const make = (routes: Record<string, (init?: RequestInit) => Response>) => {
    calls.length = 0;
    const apiFetch: FetchFn = async (url, init) => {
      calls.push({ url, init });
      const path = url.replace('https://api.test/api/v1', '');
      const route = routes[path.split('?')[0] ?? ''];
      if (!route) throw new TypeError('Failed to fetch');
      return route(init);
    };
    const fileFetch: FetchFn = async (url) => {
      calls.push({ url });
      return url === 'https://dl.test/f/1' ? new Response('1\n00:00:01,000 --> 00:00:02,000\nHi\n') : new Response('', { status: 404 });
    };
    return new OpenSubtitlesClient({ apiFetch, fileFetch, apiKey: 'k', baseUrl: 'https://api.test/api/v1', appName: 'Test v1' });
  };

  test('search: maps the answer and sends the key and app name', async () => {
    const c = make({ '/subtitles': () => json({ total_count: 2, data: [hit(1, 'en', { download_count: 7, from_trusted: true }), hit(2, 'sv', { hearing_impaired: true, ai_translated: true })] }) });
    const got = await c.search({ tmdbId: 5 });
    expect(got).toEqual([
      { fileId: 1, language: 'en', release: 'Synthetic.Film.en', downloads: 7, hearingImpaired: false, machineTranslated: false, trusted: true },
      { fileId: 2, language: 'sv', release: 'Synthetic.Film.sv', downloads: 100, hearingImpaired: true, machineTranslated: true, trusted: false },
    ]);
    expect(calls[0]?.url).toBe('https://api.test/api/v1/subtitles?tmdb_id=5');
    const h = new Headers(calls[0]?.init?.headers);
    expect(h.get('api-key')).toBe('k');
    expect(h.get('x-user-agent')).toBe('Test v1');
  });

  test('search skips entries without a file or language', async () => {
    const c = make({ '/subtitles': () => json({ data: [hit(1, 'en', { files: [] }), hit(2, '', {}), { attributes: null }, hit(3, 'en')] }) });
    expect((await c.search({ tmdbId: 5 })).map((s) => s.fileId)).toEqual([3]);
  });

  test('download: asks for a link, then fetches the file', async () => {
    const c = make({ '/download': () => json({ link: 'https://dl.test/f/1', file_name: 'synthetic.en.srt', remaining: 4 }) });
    const got = await c.download(1);
    expect(got.name).toBe('synthetic.en.srt');
    expect(new TextDecoder().decode(got.bytes)).toContain('Hi');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ file_id: 1 }));
  });

  test('errors say what the user can do', async () => {
    const quota = make({ '/download': () => json({ message: 'limit', remaining: 0 }, 406) });
    await expect(quota.download(1)).rejects.toThrow(new SubtitleError('Daily subtitle download limit reached. Try again tomorrow.'));
    const rate = make({ '/subtitles': () => json({}, 429) });
    await expect(rate.search({ tmdbId: 1 })).rejects.toThrow('The subtitle service is busy. Try again in a moment.');
    const key = make({ '/subtitles': () => json({}, 401) });
    await expect(key.search({ tmdbId: 1 })).rejects.toThrow('Online subtitles are not set up correctly.');
    const down = make({});
    await expect(down.search({ tmdbId: 1 })).rejects.toThrow("Couldn't reach the subtitle service.");
    const badLink = make({ '/download': () => json({ link: 'https://dl.test/missing' }) });
    await expect(badLink.download(1)).rejects.toThrow("Couldn't download the subtitles (error 404).");
  });
});
