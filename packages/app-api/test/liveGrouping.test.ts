import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SourceService, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi } from '../src/appApi.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 19, 18, 0);
const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="one.se" group-title="Nordic",SE: Channel One HD',
  'http://a.example.test/live/1.ts',
  '#EXTINF:-1 group-title="News",Example News',
  'http://a.example.test/live/2.ts',
  '#EXTINF:-1 tvg-id="one.se" group-title="HD",Channel One FHD',
  'http://a.example.test/live/3.ts',
  '#EXTINF:-1 group-title="HD",Channel One (backup)',
  'http://b.example.test/live/4.ts',
  '#EXTINF:-1 tvg-id="one.se" group-title="UHD",Channel One 4K',
  'http://a.example.test/live/5.ts',
  '#EXTINF:-1 tvg-id="one.se" group-title="HD",Channel One +1',
  'http://a.example.test/live/6.ts',
  '',
].join('\n');
const fetchFn: FetchFn = async (u) => {
  if (u === 'http://example.test/p.m3u') return new Response(PLAYLIST);
  return new Response('', { status: 404 });
};

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

/** `combine`: Settings → Combine duplicate channels (off by default until the TV UI for sources lands). */
async function setup(st: MemoryStorage = storage, combine = true) {
  const events: AppEvent[] = [];
  const service = new SourceService({ storage: st, fetch: fetchFn, now: () => NOW });
  const api = new AppApi({ service, storage: st, emit: (e) => events.push(e), now: () => NOW });
  live.push(api);
  const { sourceId } = await api.addSource({ kind: 'm3u', name: 'Synthetic', playlistUrl: 'http://example.test/p.m3u' });
  await api.idle();
  if (combine) await api.saveSettings({ combineChannels: true });
  const all = (await api.getChannelSlice('all', 0, 50)).rows;
  return { api, events, sourceId, all };
}

/** Channel ids by playlist position (1-based), read from the unfolded index. */
async function memberIds(api: AppApi): Promise<string[]> {
  await api.saveSettings({ combineChannels: false });
  const rows = (await api.getChannelSlice('all', 0, 50)).rows.map((r) => r.id);
  await api.saveSettings({ combineChannels: true });
  return rows;
}

describe('AppApi – combine duplicate channels off (the default)', () => {
  test('every playlist entry is its own row, played as itself, with no source fields', async () => {
    const { api, all } = await setup(storage, false);
    expect((await api.getSettings()).combineChannels).toBe(false);
    expect(all.map((r) => r.name)).toEqual([
      'SE: Channel One HD', 'Example News', 'Channel One FHD', 'Channel One (backup)', 'Channel One 4K', 'Channel One +1',
    ]);
    for (const r of all) {
      expect(r.sourceCount).toBeUndefined();
      expect(r.quality).toBeUndefined();
    }
    const p = (await api.getPlayable(all[0]!.id))!;
    expect(p).toMatchObject({ id: all[0]!.id, name: 'SE: Channel One HD', url: 'http://a.example.test/live/1.ts' });
    expect(p.rowId).toBeUndefined();
    expect(p.sources).toBeUndefined();
    expect((await api.byNumber(5))!.id).toBe(all[4]!.id);
    expect((await api.neighbour('all', all[0]!.id, 1))!.id).toBe(all[1]!.id);
    expect(await api.indexOf('all', all[3]!.id)).toBe(3);
    expect(await api.liveSources(all[0]!.id)).toHaveLength(1);
  });

  test('favourite and hide touch only the channel itself', async () => {
    const { api, all } = await setup(storage, false);
    expect(await api.toggleFavourite(all[4]!.id)).toBe(true);
    expect((await api.getLayout()).lists[0]!.channelIds).toEqual([all[4]!.id]);
    expect(await api.channelLists(all[0]!.id)).toEqual([]);
    expect(await api.toggleHidden(all[0]!.id)).toBe(true);
    expect((await api.getLayout()).hiddenChannels).toEqual([all[0]!.id]);
    expect((await api.getChannelSlice('all', 0, 50)).total).toBe(5);
  });
});

describe('AppApi – combined live channels', () => {
  test('one row per channel with its sources and best quality', async () => {
    const { all } = await setup();
    expect(all.map((r) => r.name)).toEqual(['Channel One', 'Example News', 'Channel One +1']);
    expect(all[0]).toMatchObject({ sourceCount: 4, quality: '4K' });
    expect(all[1]!.sourceCount).toBeUndefined();
    expect(all[1]!.quality).toBeUndefined();
  });

  test('guide rows carry the badge fields and the folded favourite too', async () => {
    const { api } = await setup();
    const ids = await memberIds(api);
    await api.applyLayoutOps([{ op: 'addToList', listId: 'fav', channelIds: [ids[2]!] }], 'remote');
    const rows = (await api.getEpgRows('all', 0, 50, NOW, NOW + 3_600_000)).rows.map((r) => r.channel);
    expect(rows[0]).toMatchObject({ name: 'Channel One', sourceCount: 4, quality: '4K', favourite: true });
    expect(rows[1]!.sourceCount).toBeUndefined();
    expect(rows[1]!.quality).toBeUndefined();
    expect(rows[1]!.favourite).toBe(false);
  });

  test('a row plays its best source and lists every source in order', async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    const p = (await api.getPlayable(all[0]!.id))!;
    expect(p.id).toBe(ids[4]); // the 4K stream
    expect(p.url).toBe('http://a.example.test/live/5.ts');
    expect(p.name).toBe('Channel One');
    expect(p.number).toBe(all[0]!.number);
    expect(p.rowId).toBe(all[0]!.id);
    expect(p.sources!.map((s) => s.id)).toEqual([ids[4], ids[2], ids[0], ids[3]]);
    expect(p.sources![0]).toMatchObject({ label: 'Channel One 4K', quality: '4K', bad: false, blocked: false });
  });

  test('exact plays that source; the row stays the same', async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    const p = (await api.getPlayable(ids[3]!, { exact: true }))!;
    expect(p.id).toBe(ids[3]);
    expect(p.url).toBe('http://b.example.test/live/4.ts');
    expect(p.rowId).toBe(all[0]!.id);
    expect(p.name).toBe('Channel One');
  });

  test('the source that played last comes first next time, also after a restart', async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    await api.notePlayed(ids[2]!, 'ts');
    expect((await api.getPlayable(all[0]!.id))!.id).toBe(ids[2]);
    const again = new AppApi({ service: new SourceService({ storage, fetch: fetchFn, now: () => NOW }), storage, emit: () => undefined, now: () => NOW });
    live.push(again);
    await again.init();
    expect((await again.getPlayable(all[0]!.id))!.id).toBe(ids[2]);
  });

  test('a failed source sorts last and is marked; a picked one wins', async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    await api.reportSourceFailed(ids[4]!);
    const p = (await api.getPlayable(all[0]!.id))!;
    expect(p.id).toBe(ids[2]);
    expect(p.sources!.at(-1)).toMatchObject({ id: ids[4], bad: true });
    await api.pickLiveSource(all[0]!.id, ids[3]!);
    expect((await api.getPlayable(all[0]!.id))!.id).toBe(ids[3]);
    expect((await api.liveSources(all[0]!.id)).map((s) => s.id)[0]).toBe(ids[3]);
  });

  test('a source whose host is waiting after a refusal is blocked and last', async () => {
    const { api, all, sourceId } = await setup();
    const ids = await memberIds(api);
    await api.reportStreamRefused(sourceId, 'http://a.example.test/live/5.ts');
    const views = await api.liveSources(all[0]!.id);
    expect(views[0]!.id).toBe(ids[3]); // the only stream on the other host
    expect(views.filter((v) => v.blocked)).toHaveLength(3);
  });

  test('zapping and numbers land on rows', async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    expect((await api.neighbour('all', ids[4]!, 1))!.rowId).toBeUndefined();
    expect((await api.neighbour('all', ids[4]!, 1))!.name).toBe('Example News');
    expect((await api.byNumber(5))!.rowId).toBe(all[0]!.id);
    expect(await api.indexOf('all', ids[3]!)).toBe(0);
  });

  test('favourite and hide cover every source of the row', async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    // A favourite stored on a member before combining.
    await api.applyLayoutOps([{ op: 'addToList', listId: 'fav', channelIds: [ids[4]!] }]);
    expect((await api.getChannelSlice('all', 0, 1)).rows[0]!.favourite).toBe(true);
    expect(await api.channelLists(all[0]!.id)).toEqual(['fav']);
    expect(await api.toggleFavourite(all[0]!.id)).toBe(false);
    expect((await api.getLayout()).lists[0]!.channelIds).toEqual([]);
    expect(await api.toggleFavourite(ids[4]!)).toBe(true);
    expect((await api.getLayout()).lists[0]!.channelIds).toEqual([all[0]!.id]);
    expect(await api.toggleHidden(all[0]!.id)).toBe(true);
    expect([...(await api.getLayout()).hiddenChannels].sort()).toEqual([ids[0], ids[2], ids[3], ids[4]].sort());
    expect((await api.getChannelSlice('all', 0, 50)).rows.map((r) => r.name)).toEqual(['Example News', 'Channel One +1']);
    expect(await api.toggleHidden(ids[3]!)).toBe(false);
    expect((await api.getLayout()).hiddenChannels).toEqual([]);
  });

  test("the TV's own list and hide ops on a row cover its members; the phone's stay exact", async () => {
    const { api, all } = await setup();
    const ids = await memberIds(api);
    await api.applyLayoutOps([{ op: 'createList', id: 'l-1', name: 'Mine' }, { op: 'addToList', listId: 'l-1', channelIds: [ids[3]!] }]);
    await api.applyLayoutOps([{ op: 'removeFromList', listId: 'l-1', channelIds: [all[0]!.id] }]);
    expect((await api.getLayout()).lists.find((l) => l.id === 'l-1')!.channelIds).toEqual([]);
    await api.applyLayoutOps([{ op: 'hideChannels', ids: [ids[4]!] }], 'remote');
    expect((await api.getLayout()).hiddenChannels).toEqual([ids[4]]);
  });

  test('turning the setting off shows every channel again and tells the TV', async () => {
    const { api, events } = await setup();
    events.length = 0;
    await api.saveSettings({ combineChannels: false });
    expect((await api.getChannelSlice('all', 0, 50)).total).toBe(6);
    expect(events.some((e) => e.type === 'layoutChanged')).toBe(true);
    const p = (await api.getPlayable((await api.getChannelSlice('all', 0, 1)).rows[0]!.id))!;
    expect(p.sources).toBeUndefined();
    expect(p.rowId).toBeUndefined();
  });
});
