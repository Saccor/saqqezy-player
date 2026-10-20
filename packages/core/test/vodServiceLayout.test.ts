import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../storage/src/memoryStorage.ts';
import { VodService } from '../src/service/vodService.ts';
import { emptyVodLayout, vodLayoutKey } from '../src/vod/layout.ts';
import type { SourceConfig } from '../src/types.ts';

const ms: SourceConfig = { kind: 'm3u', id: 'm', name: 'M', playlistUrl: 'http://example.test/p.m3u' };

async function setup() {
  const storage = new MemoryStorage();
  await storage.putSource(ms);
  const svc = new VodService({ storage, fetch: async () => new Response('[]'), now: () => 1 });
  return { storage, svc };
}

describe('VodService category layout', () => {
  test('empty by default; ops persist per source and kind and stamp the sync clock', async () => {
    const { storage, svc } = await setup();
    expect(await svc.getVodLayout('m', 'movie')).toEqual(emptyVodLayout());
    const r = await svc.applyVodLayoutOps('m', 'movie', [{ op: 'hideCategories', ids: ['3'] }]);
    expect(r.changed).toBe(true);
    expect(await svc.getVodLayout('m', 'movie')).toMatchObject({ hiddenCategories: ['3'], version: 1 });
    expect(await svc.getVodLayout('m', 'series')).toEqual(emptyVodLayout());
    expect(await storage.getMeta(vodLayoutKey('movie', 'm'))).toMatchObject({ hiddenCategories: ['3'] });
    expect((await storage.listSyncMeta('m')).map((e) => e.key)).toContain('ch:movie|3');
  });

  test('a removed source writes nothing', async () => {
    const { storage, svc } = await setup();
    await storage.deleteSource('m');
    const r = await svc.applyVodLayoutOps('m', 'movie', [{ op: 'hideCategories', ids: ['3'] }]);
    expect(r.changed).toBe(false);
    expect(await storage.getMeta(vodLayoutKey('movie', 'm'))).toBeUndefined();
  });
});
