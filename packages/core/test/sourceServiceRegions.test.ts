import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { SourceService } from '../src/service/sourceService.ts';
import { REGION_DETECTOR_VERSION, regionsKey } from '../src/text/regions.ts';
import type { FetchFn } from '../src/types.ts';

const tvg = readFileSync(new URL('./fixtures/regions/tvg.m3u', import.meta.url), 'utf8');
const prefixed = readFileSync(new URL('./fixtures/regions/prefixed.m3u', import.meta.url), 'utf8');

let playlist: string;
let storage: MemoryStorage;
let service: SourceService;
const fetchFn: FetchFn = async () => new Response(playlist);

beforeEach(() => {
  playlist = tvg;
  storage = new MemoryStorage();
  let n = 0;
  service = new SourceService({ storage, fetch: fetchFn, now: () => 1, newId: () => `id${++n}` });
});

const input = { kind: 'm3u' as const, name: 'Mine', playlistUrl: 'http://example.test/p.m3u' };

describe('SourceService regions cache', () => {
  test('ingest stores the detected regions with the detector version and the tvg tallies', async () => {
    const { source } = await service.addSource(input);
    const rec = await service.loadRegions(source.id);
    expect(rec?.v).toBe(REGION_DETECTOR_VERSION);
    expect(rec?.groups['g:Mixed']).toMatchObject({ countries: ['SE'], via: 'tvg' });
    expect(rec?.tvg?.['g:Mixed']?.withCountry).toBe(4);
  });

  test('a record of another version reads as stale; redetect rebuilds it from channels and stored tallies', async () => {
    const { source } = await service.addSource(input);
    const rec = (await service.loadRegions(source.id))!;
    await storage.setMeta(regionsKey(source.id), { ...rec, v: 0, groups: {} });
    expect(await service.loadRegions(source.id)).toBeUndefined();
    const fresh = await service.redetectRegions(source.id);
    expect(fresh?.groups['g:Mixed']).toMatchObject({ countries: ['SE'], via: 'tvg' });
    expect((await service.loadRegions(source.id))?.groups['g:Mixed']).toBeDefined();
  });

  test('a playlist refresh replaces the record; clearing cached data removes it', async () => {
    const { source } = await service.addSource(input);
    playlist = prefixed;
    await service.refreshPlaylist(source.id);
    const rec = await service.loadRegions(source.id);
    expect(rec?.groups['g:Mixed']).toBeUndefined();
    expect(rec?.groups['g:SE | Synthetic News']).toMatchObject({ countries: ['SE'] });
    await service.clearCachedData(source.id);
    expect(await storage.getMeta(regionsKey(source.id))).toBeFalsy();
  });

  test('garbage in storage reads as no record', async () => {
    const { source } = await service.addSource(input);
    await storage.setMeta(regionsKey(source.id), { v: REGION_DETECTOR_VERSION, groups: { 'g:x': { countries: 'SE' } } });
    expect((await service.loadRegions(source.id))?.groups['g:x']).toBeUndefined();
  });
});
