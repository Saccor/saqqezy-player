import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { SourceService } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import * as sports from '../src/sportsController.ts';
import { AppApi } from '../src/appApi.ts';

// The ranking itself is tested in sportsController.test.ts (fixture 12: a small match on a chosen country's channel
// shows in the row). Here: AppApi hands it the chosen countries from Your countries.
vi.mock('../src/sportsController.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sportsController.ts')>();
  return { ...real, matchTiles: vi.fn(real.matchTiles) };
});

const NOW = Date.UTC(2026, 9, 20, 18, 10);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 10, sports: true, now: () => NOW }); });
afterAll(async () => { await server.close(); });

async function tv() {
  const storage = new MemoryStorage();
  const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now: () => NOW };
  const api = new AppApi({ service: new SourceService({ ...deps, shortEpgGapMs: 0 }), storage, emit: () => undefined, now: () => NOW });
  await api.addSource({ kind: 'xtream', name: 'Fake', server: server.url, username: 'test', password: 'test' });
  await api.idle();
  return api;
}
const lastCountries = () => vi.mocked(sports.matchTiles).mock.calls.at(-1)?.[2].countries;

describe('AppApi – matches and Your countries (G8)', () => {
  test('the chosen countries reach the match ranking while Your countries is on; none while it is off', async () => {
    const api = await tv();
    await api.getSportsEvents();
    expect(lastCountries() ?? []).toEqual([]);
    await api.setRegions({ mode: 'first', codes: ['SE', 'NO'] });
    await api.getSportsEvents();
    expect(lastCountries()).toEqual(['SE', 'NO']);
    await api.setRegions({ mode: 'only', codes: ['DK'] });
    await api.getStartHome();
    expect(lastCountries()).toEqual(['DK']);
    await api.setRegions({ mode: 'off', codes: ['DK'] });
    await api.getSportsEvents();
    expect(lastCountries() ?? []).toEqual([]);
    await api.idle();
  });
});
