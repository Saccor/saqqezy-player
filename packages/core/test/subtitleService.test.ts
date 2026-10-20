import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SUBTITLE_KEEP, SubtitleError, SubtitleService } from '../src/subtitles/service.ts';
import type { FetchFn } from '../src/types.ts';
import { SUBTITLE_MAX_BYTES } from '../src/subtitles/parse.ts';

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
const bytes = (s: string) => new TextEncoder().encode(s);

let storage: MemoryStorage;
let routes: Record<string, () => Response | Promise<Response>>;
let fetched: string[];
const fetchFn: FetchFn = async (url) => {
  fetched.push(url);
  const r = routes[url];
  if (!r) throw new TypeError('Failed to fetch');
  return r();
};
let svc: SubtitleService;

beforeEach(() => {
  storage = new MemoryStorage();
  routes = {};
  fetched = [];
  svc = new SubtitleService({ storage, fetch: fetchFn });
});

describe('SubtitleService', () => {
  test('a link: downloads, parses, names it after the file, and keeps it for that title', async () => {
    routes['http://example.test/subs/My%20Film.en.srt?x=1'] = () => new Response(SRT);
    const got = await svc.load('src', 'item1', { url: ' http://example.test/subs/My%20Film.en.srt?x=1 ' });
    expect(got).toEqual({ name: 'My Film.en.srt', cues: [{ startMs: 1000, endMs: 2000, text: 'Hello' }] });
    expect(await svc.get('src', 'item1')).toEqual(got);
    expect(await svc.get('src', 'item2')).toBeUndefined();
    expect(await svc.get('other', 'item1')).toBeUndefined();
  });

  test('a file: bytes decoded and parsed', async () => {
    const got = await svc.load('src', 'item1', { bytes: bytes(`WEBVTT\n\n00:01.000 --> 00:02.000\nHej\n`), name: 'film.vtt' });
    expect(got.name).toBe('film.vtt');
    expect(got.cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hej' }]);
  });

  test('a delay is kept with the title\'s file, clamped to ±60 s; a new file starts at 0', async () => {
    await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'a.srt' });
    expect((await svc.get('src', 'item1'))?.delayMs).toBeUndefined();
    await svc.setDelay('src', 'item1', 1500);
    expect((await svc.get('src', 'item1'))?.delayMs).toBe(1500);
    await svc.setDelay('src', 'item1', -999_999);
    expect((await svc.get('src', 'item1'))?.delayMs).toBe(-60_000);
    await svc.setDelay('src', 'none', 500); // no file: nothing to keep
    expect(await svc.get('src', 'none')).toBeUndefined();
    await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'b.srt' });
    expect((await svc.get('src', 'item1'))?.delayMs).toBeUndefined();
  });

  test('a speed is kept with the title\'s file next to the delay; old records have none; a new file starts without', async () => {
    await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'a.srt' });
    expect((await svc.get('src', 'item1'))?.speed).toBeUndefined();
    await svc.setSpeed('src', 'item1', 23.976 / 25);
    await svc.setDelay('src', 'item1', 700);
    expect(await svc.get('src', 'item1')).toMatchObject({ speed: 23.976 / 25, delayMs: 700 });
    await svc.setSpeed('src', 'item1', 1);
    expect((await svc.get('src', 'item1'))?.speed).toBe(1);
    // Nonsense is Normal.
    await svc.setSpeed('src', 'item1', Number.NaN);
    expect((await svc.get('src', 'item1'))?.speed).toBe(1);
    await svc.setSpeed('src', 'item1', 7);
    expect((await svc.get('src', 'item1'))?.speed).toBe(1);
    await svc.setSpeed('src', 'none', 1); // no file: nothing to keep
    expect(await svc.get('src', 'none')).toBeUndefined();
    await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'b.srt' });
    expect((await svc.get('src', 'item1'))?.speed).toBeUndefined();
  });

  test('a file found online keeps its language, file id and frame rate', async () => {
    const got = await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'Swedish' }, { language: 'sv', fileId: 2002, fps: 23.976 });
    expect(got).toMatchObject({ name: 'Swedish', language: 'sv', online: { language: 'sv', fileId: 2002 }, fps: 23.976 });
    expect(await svc.get('src', 'item1')).toEqual(got);
    const plain = await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'a.srt' }, { fps: 0 });
    expect('fps' in plain).toBe(false);
    expect('online' in plain).toBe(false);
  });

  test('a file from the source keeps its language and the given name (never one taken from its link)', async () => {
    const got = await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'x' }, { language: 'en', name: 'English (from source)' });
    expect(got).toMatchObject({ name: 'English (from source)', language: 'en' });
    expect('online' in got).toBe(false);
  });

  test('clear forgets a title', async () => {
    await svc.load('src', 'item1', { bytes: bytes(SRT), name: 'a.srt' });
    await svc.clear('src', 'item1');
    expect(await svc.get('src', 'item1')).toBeUndefined();
  });

  test('keeps the most recent SUBTITLE_KEEP titles; a reload counts as recent', async () => {
    for (let i = 0; i < SUBTITLE_KEEP; i++) await svc.load('src', `i${i}`, { bytes: bytes(SRT), name: 'a.srt' });
    await svc.load('src', 'i0', { bytes: bytes(SRT), name: 'again.srt' });
    await svc.load('src', 'new', { bytes: bytes(SRT), name: 'a.srt' });
    expect((await svc.get('src', 'i0'))?.name).toBe('again.srt');
    expect(await svc.get('src', 'i1')).toBeUndefined();
    expect(await svc.get('src', 'new')).toBeDefined();
  });

  test('errors the user can act on', async () => {
    await expect(svc.load('s', 'i', { url: 'ftp://example.test/a.srt' })).rejects.toThrow(new SubtitleError('Enter a link that starts with http:// or https://.'));
    await expect(svc.load('s', 'i', { url: 'not a link' })).rejects.toThrow(SubtitleError);
    await expect(svc.load('s', 'i', { url: 'http://example.test/none.srt' })).rejects.toThrow("Couldn't download the subtitles. Check the link.");
    routes['http://example.test/404.srt'] = () => new Response('nope', { status: 404 });
    await expect(svc.load('s', 'i', { url: 'http://example.test/404.srt' })).rejects.toThrow("Couldn't download the subtitles (error 404).");
    routes['http://example.test/page.srt'] = () => new Response('<html>hi</html>');
    await expect(svc.load('s', 'i', { url: 'http://example.test/page.srt' })).rejects.toThrow('No subtitles found. Use an .srt or .vtt file.');
    await expect(svc.load('s', 'i', { bytes: new Uint8Array(6 * 1024 * 1024), name: 'big.srt' })).rejects.toThrow('That file is too large to be subtitles.');
    routes['http://example.test/big.srt'] = () => new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } });
    await expect(svc.load('s', 'i', { url: 'http://example.test/big.srt' })).rejects.toThrow('That file is too large to be subtitles.');
    expect(await svc.get('s', 'i')).toBeUndefined();
  });

  test('a body without content-length is read only up to the limit, then cancelled', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024).fill(0x41);
    routes['http://example.test/chunked.srt'] = () => new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        // Endless: only cancelling ends it.
        pulled += chunk.length;
        c.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }));
    await expect(svc.load('s', 'i', { url: 'http://example.test/chunked.srt' })).rejects.toThrow(new SubtitleError('That file is too large to be subtitles.'));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(SUBTITLE_MAX_BYTES + 4 * chunk.length);
  });

  test('a chunked body under the limit is read whole', async () => {
    const b = bytes(SRT);
    routes['http://example.test/small.srt'] = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(b.slice(0, 5)); c.enqueue(b.slice(5)); c.close(); },
    }));
    expect((await svc.load('s', 'i', { url: 'http://example.test/small.srt' })).cues).toHaveLength(1);
  });

  test('a video or audio link is refused before its body is read', async () => {
    for (const type of ['video/mp4', 'audio/mpeg', 'Video/MP2T; charset=binary']) {
      let pulled = false;
      let cancelled = false;
      routes['http://example.test/film.srt'] = () => new Response(new ReadableStream<Uint8Array>({
        pull(c) { pulled = true; c.enqueue(new Uint8Array(10)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': type } });
      await expect(svc.load('s', 'i', { url: 'http://example.test/film.srt' })).rejects.toThrow(new SubtitleError("That link is a video or audio file, not subtitles."));
      expect(cancelled).toBe(true);
      expect(pulled).toBe(false);
    }
  });
});
