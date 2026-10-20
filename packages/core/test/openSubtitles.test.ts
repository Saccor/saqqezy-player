import { describe, expect, test } from 'vitest';
import {
  OpenSubtitlesClient, bestSubtitle, languageChoices, rankSubtitles, searchParams, searchTitle, type OnlineSubtitle,
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
  fileId, language, release: `r${fileId}`, downloads: 0, hearingImpaired: false, machineTranslated: false, trusted: false, hashMatch: false, ...o,
});

describe('searchParams', () => {
  test('movie by TMDB id, keys sorted and values lower-case (the API redirects otherwise)', () => {
    expect(searchParams({ tmdbId: 123, query: 'Ignored', languages: ['sv', 'en'] })).toBe('languages=en,sv&tmdb_id=123');
  });

  test('the file hash goes along with the id (results then say which files match it)', () => {
    expect(searchParams({ tmdbId: 123, moviehash: '00ABCDEF01234567' })).toBe('moviehash=00abcdef01234567&tmdb_id=123');
    expect(searchParams({ query: 'Synthetic Film', moviehash: '0000000000020000' })).toBe('moviehash=0000000000020000&query=synthetic+film');
  });

  test('page: added after the first, keys still sorted', () => {
    expect(searchParams({ tmdbId: 123, languages: ['en'], page: 2 })).toBe('languages=en&page=2&tmdb_id=123');
    expect(searchParams({ tmdbId: 123, page: 1 })).toBe('tmdb_id=123');
    expect(searchParams({ tmdbId: 123 })).toBe('tmdb_id=123');
  });

  test('page: a fraction is floored before the check (1.5 is the first page)', () => {
    expect(searchParams({ tmdbId: 123, page: 1.5 })).toBe('tmdb_id=123');
    expect(searchParams({ tmdbId: 123, page: 2.9 })).toBe('page=2&tmdb_id=123');
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
  test('best: a hash match (timed for this exact file) beats everything else', () => {
    expect(bestSubtitle([sub(1, 'en', { downloads: 900, trusted: true }), sub(2, 'en', { hashMatch: true, machineTranslated: true })])?.fileId).toBe(2);
  });

  test('best: trusted, then not machine-translated, then not hearing-impaired, then most downloaded', () => {
    expect(bestSubtitle([sub(1, 'en', { downloads: 900, machineTranslated: true }), sub(2, 'en', { downloads: 10 })])?.fileId).toBe(2);
    expect(bestSubtitle([sub(1, 'en', { downloads: 900 }), sub(2, 'en', { downloads: 5, trusted: true })])?.fileId).toBe(2);
    expect(bestSubtitle([sub(1, 'en', { downloads: 900, hearingImpaired: true }), sub(2, 'en', { downloads: 5 })])?.fileId).toBe(2);
    expect(bestSubtitle([sub(1, 'en', { downloads: 5 }), sub(2, 'en', { downloads: 50 })])?.fileId).toBe(2);
    expect(bestSubtitle([])).toBeUndefined();
  });

  test('with the video frame rate: matching fps first, unknown between, other known fps last (after the hash match)', () => {
    const list = [
      sub(1, 'en', { fps: 25, trusted: true, downloads: 900 }),
      sub(2, 'en', { downloads: 5 }),
      sub(3, 'en', { fps: 23.976, downloads: 1 }),
      sub(4, 'en', { fps: 25, hashMatch: true }),
    ];
    expect(rankSubtitles(list, 23.976).map((s) => s.fileId)).toEqual([4, 3, 2, 1]);
    expect(rankSubtitles(list.slice(0, 3), 23.976).map((s) => s.fileId)).toEqual([3, 2, 1]);
    expect(rankSubtitles(list.slice(0, 3), 23.98).map((s) => s.fileId)).toEqual([3, 2, 1]);
    expect(languageChoices(list.slice(0, 3), 'en', 25)[0]?.best.fileId).toBe(1);
    expect(languageChoices(list.slice(0, 3), 'en', 23.976)[0]?.best.fileId).toBe(3);
  });

  test('ranking is unchanged without a video frame rate', () => {
    const list = [
      sub(1, 'en', { fps: 25, downloads: 5 }),
      sub(2, 'en', { fps: 23.976, downloads: 50 }),
      sub(3, 'en', { trusted: true, downloads: 1 }),
    ];
    expect(rankSubtitles(list).map((s) => s.fileId)).toEqual([3, 2, 1]);
  });

  test('one row per language: preferred first, then by count, then by code; each with its best file', () => {
    const list = [sub(1, 'en'), sub(2, 'en', { downloads: 9 }), sub(3, 'fr'), sub(4, 'sv'), sub(5, 'de'), sub(6, 'de')];
    expect(languageChoices(list, 'sv').map((c) => [c.language, c.count, c.best.fileId])).toEqual([
      ['sv', 1, 4], ['de', 2, 5], ['en', 2, 2], ['fr', 1, 3],
    ]);
    expect(languageChoices(list, 'off')[0]?.language).toBe('de');
    expect(languageChoices([sub(1, 'pt-BR')], 'pt').map((c) => c.language)).toEqual(['pt-BR']);
  });

  test('each language keeps all its files best first ("another version" walks them) and says when one matches the file', () => {
    const list = [sub(1, 'en', { downloads: 5 }), sub(2, 'en', { downloads: 50 }), sub(3, 'en', { hashMatch: true }), sub(4, 'sv')];
    const [en, sv] = languageChoices(list, 'en');
    expect(en!.files.map((f) => f.fileId)).toEqual([3, 2, 1]);
    expect(en!.synced).toBe(true);
    expect(sv!.synced).toBe(false);
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
    const c = make({ '/subtitles': () => json({ total_count: 2, data: [hit(1, 'en', { download_count: 7, from_trusted: true }), hit(2, 'sv', { hearing_impaired: true, ai_translated: true, moviehash_match: true })] }) });
    const got = await c.search({ tmdbId: 5 });
    expect(got).toEqual([
      { fileId: 1, language: 'en', release: 'Synthetic.Film.en', downloads: 7, hearingImpaired: false, machineTranslated: false, trusted: true, hashMatch: false },
      { fileId: 2, language: 'sv', release: 'Synthetic.Film.sv', downloads: 100, hearingImpaired: true, machineTranslated: true, trusted: false, hashMatch: true },
    ]);
    expect(calls[0]?.url).toBe('https://api.test/api/v1/subtitles?tmdb_id=5');
    const h = new Headers(calls[0]?.init?.headers);
    expect(h.get('api-key')).toBe('k');
    expect(h.get('x-user-agent')).toBe('Test v1');
  });

  test('search: fps is read when it is a positive number, otherwise left out', async () => {
    const c = make({ '/subtitles': () => json({ data: [hit(1, 'en', { fps: 23.976 }), hit(2, 'en', { fps: 0 }), hit(3, 'en', { fps: '25' }), hit(4, 'en')] }) });
    const got = await c.search({ tmdbId: 5 });
    expect(got.map((s) => s.fps)).toEqual([23.976, undefined, undefined, undefined]);
    expect('fps' in got[1]!).toBe(false);
  });

  test('search: an infinite fps (1e400 parses to Infinity) is left out', async () => {
    const body = `{"data":[${JSON.stringify(hit(1, 'en')).replace(/}}$/, ',"fps":1e400}}')}]}`;
    const c = make({ '/subtitles': () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
    const got = await c.search({ tmdbId: 5 });
    expect(got).toHaveLength(1);
    expect('fps' in got[0]!).toBe(false);
  });

  test('searchPage: the subtitles plus the page count the service reports (undefined when it does not)', async () => {
    let c = make({ '/subtitles': () => json({ total_pages: 3, page: 1, data: [hit(1, 'en')] }) });
    expect(await c.searchPage({ tmdbId: 5 })).toEqual({ subtitles: [expect.objectContaining({ fileId: 1 })], totalPages: 3 });
    c = make({ '/subtitles': () => json({ data: [hit(1, 'en')] }) });
    expect((await c.searchPage({ tmdbId: 5 })).totalPages).toBeUndefined();
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
