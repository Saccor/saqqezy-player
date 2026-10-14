import { describe, expect, test } from 'vitest';
import type { Channel, Programme, SourceConfig, Storage } from '@iptv/core';

const src: SourceConfig = { kind: 'm3u', id: 's1', name: 'Test', playlistUrl: 'http://example.test/p.m3u' };
const other: SourceConfig = { kind: 'm3u', id: 's2', name: 'Other', playlistUrl: 'http://example.test/o.m3u' };
const chan = (n: number, sourceId = 's1'): Channel => ({
  id: `${sourceId}:${n}`, sourceId, name: `Channel ${n}`, url: `http://example.test/${n}.ts`, group: 'G', number: n,
});
const prog = (epgId: string, startH: number, stopH: number): Programme => ({
  epgId, start: startH * 3600_000, stop: stopH * 3600_000, title: `${epgId}@${startH}`,
});

export function storageContract(name: string, make: () => Promise<Storage> | Storage) {
  describe(`${name} storage contract`, () => {
    test('sources: put, list, update, delete', async () => {
      const s = await make();
      await s.putSource(src);
      await s.putSource(other);
      await s.putSource({ ...src, name: 'Renamed' });
      expect((await s.listSources()).map((x) => x.name).sort()).toEqual(['Other', 'Renamed']);
      await s.deleteSource('s2');
      expect((await s.listSources()).map((x) => x.id)).toEqual(['s1']);
    });

    test('channels: replace and get, empty by default', async () => {
      const s = await make();
      expect(await s.getChannels('s1')).toEqual([]);
      await s.replaceChannels('s1', [chan(1), chan(2)]);
      await s.replaceChannels('s1', [chan(3)]);
      expect(await s.getChannels('s1')).toEqual([chan(3)]);
    });

    test('meta: set and get any JSON value', async () => {
      const s = await make();
      expect(await s.getMeta('missing')).toBeUndefined();
      await s.setMeta('flags:s1', { favourites: ['a'], hidden: [] });
      expect(await s.getMeta('flags:s1')).toEqual({ favourites: ['a'], hidden: [] });
    });

    test('programmes: overlap query, sorted, per source, cleared', async () => {
      const s = await make();
      await s.addProgrammes('s1', [prog('b', 10, 11), prog('a', 9, 10), prog('a', 10, 12), prog('a', 20, 21)]);
      await s.addProgrammes('s2', [prog('a', 10, 11)]);
      const got = await s.getProgrammes('s1', ['a', 'b', 'zzz'], 9.5 * 3600_000, 11 * 3600_000);
      expect(got.map((p) => p.title)).toEqual(['a@9', 'a@10', 'b@10']);
      await s.clearProgrammes('s1');
      expect(await s.getProgrammes('s1', ['a', 'b'], 0, 100 * 3600_000)).toEqual([]);
      expect(await s.getProgrammes('s2', ['a'], 0, 100 * 3600_000)).toHaveLength(1);
    });

    test('programmes: forEachProgramme visits every programme of one source only', async () => {
      const s = await make();
      await s.addProgrammes('s1', [prog('a', 1, 2), prog('b', 3, 4)]);
      await s.addProgrammes('s2', [prog('c', 1, 2)]);
      const seen: string[] = [];
      await s.forEachProgramme('s1', (p) => seen.push(p.title));
      expect(seen.sort()).toEqual(['a@1', 'b@3']);
      const none: string[] = [];
      await s.forEachProgramme('missing', (p) => none.push(p.title));
      expect(none).toEqual([]);
    });

    test('deleteSource removes channels, programmes and source-scoped meta', async () => {
      const s = await make();
      await s.putSource(src);
      await s.replaceChannels('s1', [chan(1)]);
      await s.addProgrammes('s1', [prog('a', 1, 2)]);
      await s.setMeta('flags:s1', { favourites: [], hidden: [] });
      await s.setMeta('activeSource', 's1');
      await s.deleteSource('s1');
      expect(await s.getChannels('s1')).toEqual([]);
      expect(await s.getProgrammes('s1', ['a'], 0, 10 * 3600_000)).toEqual([]);
      expect(await s.getMeta('flags:s1')).toBeUndefined();
      expect(await s.getMeta('activeSource')).toBe('s1');
    });

    test('deleteSource leaves other sources channels, programmes and meta intact', async () => {
      const s = await make();
      await s.putSource(src);
      await s.putSource(other);
      await s.replaceChannels('s1', [chan(1)]);
      await s.replaceChannels('s2', [chan(2, 's2')]);
      await s.addProgrammes('s1', [prog('a', 1, 2)]);
      await s.addProgrammes('s2', [prog('a', 1, 2), prog('b', 3, 4)]);
      await s.setMeta('flags:s1', { favourites: [], hidden: [] });
      await s.setMeta('flags:s2', { favourites: ['x'], hidden: [] });
      await s.deleteSource('s1');
      expect((await s.listSources()).map((x) => x.id)).toEqual(['s2']);
      expect(await s.getChannels('s2')).toEqual([chan(2, 's2')]);
      expect((await s.getProgrammes('s2', ['a', 'b'], 0, 10 * 3600_000)).map((p) => p.title)).toEqual(['a@1', 'b@3']);
      expect(await s.getMeta('flags:s2')).toEqual({ favourites: ['x'], hidden: [] });
      expect(await s.getMeta('flags:s1')).toBeUndefined();
    });

    test('programmes: overlapping-start included, start at "to" excluded', async () => {
      const s = await make();
      await s.addProgrammes('s1', [prog('a', 8, 10), prog('a', 11, 12), prog('a', 7, 9)]);
      const got = await s.getProgrammes('s1', ['a'], 9 * 3600_000, 11 * 3600_000);
      expect(got.map((p) => p.title)).toEqual(['a@8']);
    });

    test('programmes: unsorted and duplicate epgIds give sorted, de-duplicated output without sourceId', async () => {
      const s = await make();
      await s.addProgrammes('s1', [prog('b', 2, 3), prog('a', 2, 3), prog('a', 1, 2)]);
      const got = await s.getProgrammes('s1', ['b', 'a', 'b', 'a'], 0, 10 * 3600_000);
      expect(got.map((p) => p.title)).toEqual(['a@1', 'a@2', 'b@2']);
      for (const p of got) expect('sourceId' in p).toBe(false);
    });

    test('programmes: multiple addProgrammes batches accumulate', async () => {
      const s = await make();
      await s.addProgrammes('s1', [prog('a', 1, 2)]);
      await s.addProgrammes('s1', [prog('a', 2, 3)]);
      const got = await s.getProgrammes('s1', ['a'], 0, 10 * 3600_000);
      expect(got.map((p) => p.title)).toEqual(['a@1', 'a@2']);
    });

    test('clearAll wipes everything', async () => {
      const s = await make();
      await s.putSource(src);
      await s.replaceChannels('s1', [chan(1)]);
      await s.setMeta('activeSource', 's1');
      await s.clearAll();
      expect(await s.listSources()).toEqual([]);
      expect(await s.getChannels('s1')).toEqual([]);
      expect(await s.getMeta('activeSource')).toBeUndefined();
    });
  });
}
