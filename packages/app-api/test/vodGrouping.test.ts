import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, VOD_ALL, VodService, type VodItem, type VodList } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import { VOD_ROW_CONTINUE, VOD_ROW_FAVOURITES, VodController } from '../src/vodController.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 19, 18, 0);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 1, movies: 5, series: 1, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const movie = (n: number, title: string, extra: Partial<VodItem> = {}): VodItem => ({ id: `SRC:m${n}`, kind: 'movie', title, categoryId: '1', xid: n, ...extra });
const series = (n: number, title: string): VodItem => ({ id: `SRC:s${n}`, kind: 'series', title, categoryId: '1', xid: n });

let storage: MemoryStorage;
let settings: { combineDuplicates: boolean; preferredLanguages: string[] };
beforeEach(() => {
  storage = new MemoryStorage();
  settings = { combineDuplicates: true, preferredLanguages: ['sv'] };
});

async function setup() {
  const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW, fallbackGapMs: 0 };
  const sources = new SourceService(deps);
  const vod = new VodService(deps);
  const { source } = await sources.addSource({ kind: 'xtream', name: 'Fake', server: server.url, username: 'test', password: 'test' });
  const id = source.id;
  const fix = (it: VodItem): VodItem => ({ ...it, id: it.id.replace('SRC', id) });
  const movies: VodList = {
    items: [
      movie(1, 'EN - Synthetic Film (2021) HD'),
      movie(2, 'SE - Synthetic Film (2021) FHD'),
      movie(3, 'DK - Synthetic Film (2021) 4K', { poster: 'http://img.test/3.jpg' }),
      movie(4, 'Example Story (2020)'),
      movie(5, 'EN - Example Story (2020)'),
    ].map(fix),
    categories: [{ id: '1', kind: 'movie', name: 'Movies', count: 5 }],
  };
  const shows: VodList = {
    items: [series(1, 'EN - Example Show'), series(2, 'SE - Example Show')].map(fix),
    categories: [{ id: '1', kind: 'series', name: 'Series', count: 2 }],
  };
  await storage.replaceVod(id, 'movie', movies);
  await storage.replaceVod(id, 'series', shows);
  // Fresh: no background fetch replaces the synthetic lists.
  await storage.setMeta(`vodAt:movie:${id}`, NOW);
  await storage.setMeta(`vodAt:series:${id}`, NOW);
  const events: AppEvent[] = [];
  const c = new VodController({
    vod, emit: (e) => events.push(e), record: (_w, err) => (err instanceof Error ? err : new Error(String(err))),
    settings: async () => settings, locale: () => 'en-US',
  });
  c.reset(id);
  const m = (n: number) => `${id}:m${n}`;
  return { c, vod, id, m, s: (n: number) => `${id}:s${n}`, events };
}

describe('VodController with combined titles', () => {
  test('one tile per title, with its version count and best quality', async () => {
    const { c, m } = await setup();
    const page = await c.slice('movie', VOD_ALL, 'title', 0, 10);
    expect(page.total).toBe(2);
    expect(page.rows.map((t) => [t.id, t.title, t.versions, t.quality])).toEqual([
      [m(4), 'Example Story', 2, undefined], [m(3), 'Synthetic Film', 3, '4K'],
    ]);
  });

  test('the detail lists every version; Play picks the preferred language, then the pick', async () => {
    const { c, m } = await setup();
    const v = (await c.movie(m(1)))!;
    expect(v.tile.id).toBe(m(3));
    expect(v.playId).toBe(m(2));
    expect(v.versions.map((x) => [x.id, x.lang, x.quality, x.auto])).toEqual([
      [m(2), 'sv', 'FHD', true], [m(3), 'da', '4K', false], [m(1), 'en', 'HD', false],
    ]);
    await c.pickVersion(m(3), m(1));
    expect((await c.movie(m(3)))!.playId).toBe(m(1));
  });

  test('a version with no language in its name gets the one the source probed, once its details are loaded', async () => {
    const { c, m } = await setup();
    // "Example Story (2020)" (m4) names no language; the fake source probes its audio as English. Only the label
    // learns it: the order (and so Play's pick) never depends on which details happen to be cached.
    expect(await c.versionLanguages(m(5))).toEqual({ [m(4)]: 'en' });
    expect((await c.movie(m(5)))!.versions.map((x) => [x.id, x.lang])).toEqual([[m(4), 'en'], [m(5), 'en']]);
  });

  test('the version Play picks is labelled from its own details at once', async () => {
    const { c, m } = await setup();
    expect((await c.movie(m(5)))!.versions.map((x) => [x.id, x.lang])).toEqual([[m(4), 'en'], [m(5), 'en']]);
  });

  test('versionLanguages: nothing to fill in, or nothing probed: an empty answer', async () => {
    const { c, m } = await setup();
    expect(await c.versionLanguages(m(3))).toEqual({});
    expect(await c.versionLanguages('not-an-id')).toEqual({});
  });

  test('a card id plays the picked version; exact plays the given one', async () => {
    const { c, m } = await setup();
    expect((await c.playable(m(3)))!).toMatchObject({ itemId: m(2), title: 'Synthetic Film' });
    expect((await c.playable(m(3), undefined, true))!).toMatchObject({ itemId: m(3), title: 'Synthetic Film' });
  });

  test('a version in progress is what Play resumes, and Continue shows the title once', async () => {
    const { c, m } = await setup();
    await c.saveProgress(m(1), 120_000, 600_000);
    await c.saveProgress(m(5), 60_000, 600_000);
    expect((await c.movie(m(3)))!.playId).toBe(m(1));
    const cont = await c.slice('movie', VOD_ROW_CONTINUE, 'title', 0, 10);
    // Both saved at the same time: the order is a tie, so compare as a set.
    expect(cont.rows.map((t) => [t.id, t.progress]).sort()).toEqual([[m(3), 0.2], [m(4), 0.1]]);
  });

  test('a favourite version marks the title; unmarking the title clears every version', async () => {
    const { c, m } = await setup();
    await c.slice('movie', VOD_ALL, 'title', 0, 10);
    await c.setFavourite(m(1), true);
    await c.setFavourite(m(2), true);
    const favs = await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 10);
    expect(favs.rows.map((t) => [t.id, t.favourite])).toEqual([[m(3), true]]);
    await c.setFavourite(m(3), false);
    expect((await c.slice('movie', VOD_ROW_FAVOURITES, 'title', 0, 10)).total).toBe(0);
  });

  test('Show separately and Combine again', async () => {
    const { c, m, events } = await setup();
    await c.slice('movie', VOD_ALL, 'title', 0, 10);
    await c.setSplit(m(1), true);
    expect(events.some((e) => e.type === 'vodRefreshed')).toBe(true);
    const split = await c.slice('movie', VOD_ALL, 'title', 0, 10);
    expect(split.total).toBe(4);
    const one = (await c.movie(m(1)))!;
    expect(one).toMatchObject({ split: true, playId: m(1), versions: [] });
    await c.setSplit(m(1), false);
    expect((await c.slice('movie', VOD_ALL, 'title', 0, 10)).total).toBe(2);
  });

  test('Combine duplicates off: one tile per item, as before', async () => {
    const { c } = await setup();
    settings = { ...settings, combineDuplicates: false };
    c.settingsChanged(true);
    const page = await c.slice('movie', VOD_ALL, 'title', 0, 10);
    expect(page.total).toBe(5);
    expect(page.rows.every((t) => t.versions === undefined)).toBe(true);
  });

  test('series: the preferred version is shown; another can be asked for', async () => {
    const { c, s } = await setup();
    const v = (await c.series(s(1)))!;
    expect(v.tile.id).toBe(s(1));
    expect(v.versionId).toBe(s(2));
    expect(v.versions.map((x) => x.id)).toEqual([s(2), s(1)]);
    expect((await c.series(s(1), s(1)))!.versionId).toBe(s(1));
    expect((await c.series(s(1), 'not-a-version'))!.versionId).toBe(s(2));
  });
});
