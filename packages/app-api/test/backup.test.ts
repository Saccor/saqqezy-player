import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { SourceService, VodService, type BackupEnvelope } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import { APP_API_METHODS, AppApi } from '../src/appApi.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 20, 18, 10);
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 20, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const live: AppApi[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((a) => a.idle())); });

function make(now = () => NOW) {
  const storage = new MemoryStorage();
  const events: AppEvent[] = [];
  const deps = { storage, fetch: (u: string, i?: RequestInit) => fetch(u, i), now };
  const service = new SourceService({ ...deps, shortEpgGapMs: 0 });
  const vod = new VodService({ ...deps, syncClock: service.syncClock });
  const api = new AppApi({ service, storage, vod, emit: (e) => events.push(e), now, appVersion: '1.2.3', backupIterations: 1000 });
  live.push(api);
  return { api, events, storage };
}
const xt = () => ({ kind: 'xtream' as const, name: 'Fake', server: server.url, username: 'test', password: 'test' });

async function tvWithEdits() {
  const a = make();
  await a.api.addSource(xt());
  const rows = (await a.api.getChannelSlice('all', 0, 3)).rows;
  await a.api.applyLayoutOps([{ op: 'hideChannels', ids: [rows[0]!.id] }, { op: 'renameChannel', id: rows[1]!.id, name: 'Morning desk' }]);
  await a.api.toggleFavourite(rows[2]!.id);
  await a.api.saveSettings({ subtitleLanguage: 'sv' });
  return { ...a, rows };
}
const suffix = (id: string) => id.slice(id.indexOf(':'));

describe('AppApi backup and restore', () => {
  test('a file backup restores onto another TV with the same account', async () => {
    const a = await tvWithEdits();
    const file = await a.api.backupToFile();
    expect(file.code).toHaveLength(26);
    expect(file.fileName).toMatch(/^tv-backup-2026-10-20\.json$/);
    expect(file.data).not.toContain('127.0.0.1');

    const b = make();
    await b.api.addSource(xt());
    const res = await b.api.restoreFromFile(file.data, file.code.toLowerCase());
    expect(res.sources).toBe(1);
    expect(res.applied).toBeGreaterThanOrEqual(4);
    const layout = await b.api.getLayout();
    expect(layout.hiddenChannels.map(suffix)).toEqual([suffix(a.rows[0]!.id)]);
    expect(Object.entries(layout.channelNames).map(([k, v]) => [suffix(k), v])).toEqual([[suffix(a.rows[1]!.id), 'Morning desk']]);
    expect(layout.lists[0]!.channelIds.map(suffix)).toEqual([suffix(a.rows[2]!.id)]);
    expect((await b.api.init()).settings.subtitleLanguage).toBe('sv');
    expect(b.events.some((e) => e.type === 'layoutChanged')).toBe(true);
    expect(b.events.find((e) => e.type === 'backupRestored')).toMatchObject({ type: 'backupRestored', applied: res.applied, origin: 'local' });
  });

  test('a wrong code or a damaged file is refused with a clear error', async () => {
    const a = await tvWithEdits();
    const file = await a.api.backupToFile();
    const b = make();
    await expect(b.api.restoreFromFile(file.data, '0'.repeat(26))).rejects.toMatchObject({ name: 'BackupError', message: expect.stringMatching(/recovery code/i) });
    await expect(b.api.restoreFromFile('{"nope":1}', file.code)).rejects.toMatchObject({ name: 'BackupError' });
    await expect(b.api.restoreFromFile('not json', file.code)).rejects.toMatchObject({ name: 'BackupError' });
  });

  test('a phone restore needs the TV to wait for it, once', async () => {
    const a = await tvWithEdits();
    const file = await a.api.backupToFile();
    const envelope = JSON.parse(file.data) as BackupEnvelope;
    const b = make();
    await b.api.addSource(xt());
    await expect(b.api.restoreFromCompanion(envelope, file.code)).rejects.toMatchObject({ name: 'NotReady' });
    const armed = await b.api.armPhoneRestore(true);
    expect(armed.until).toBeGreaterThan(NOW);
    const res = await b.api.restoreFromCompanion(envelope, file.code);
    expect(res.applied).toBeGreaterThan(0);
    expect(b.events.find((e) => e.type === 'backupRestored')).toMatchObject({ origin: 'remote' });
    await expect(b.api.restoreFromCompanion(envelope, file.code)).rejects.toMatchObject({ name: 'NotReady' });
    // A wrong code keeps the TV waiting, so the user can type it again.
    await b.api.armPhoneRestore(true);
    await expect(b.api.restoreFromCompanion(envelope, '1'.repeat(26))).rejects.toMatchObject({ name: 'BackupError' });
    await expect(b.api.restoreFromCompanion(envelope, file.code)).resolves.toMatchObject({ applied: 0 });
    expect((await b.api.armPhoneRestore(false)).until).toBeUndefined();
  });

  test('restored before the source was added: applied when it is', async () => {
    const a = await tvWithEdits();
    const file = await a.api.backupToFile();
    const b = make();
    const res = await b.api.restoreFromFile(file.data, file.code);
    expect(res.sources).toBe(0);
    expect(res.pending).toBeGreaterThan(0);
    await b.api.addSource(xt());
    await b.api.idle();
    expect((await b.api.getLayout()).hiddenChannels.map(suffix)).toEqual([suffix(a.rows[0]!.id)]);
  });

  test('backing up to the phone needs a connected phone', async () => {
    const a = await tvWithEdits();
    await expect(a.api.backupToPhone()).rejects.toMatchObject({ name: 'NoCompanion' });
  });

  test('the TV UI can call the backup methods; the companion-only restore is not exposed', () => {
    for (const m of ['backupToPhone', 'backupToFile', 'restoreFromFile', 'armPhoneRestore']) expect(APP_API_METHODS).toContain(m);
    expect(APP_API_METHODS).not.toContain('restoreFromCompanion');
  });
});
