import { describe, expect, test } from 'vitest';
import { MemoryStorage } from '../../../storage/src/memoryStorage.ts';
import { applyOps } from '../../src/layout/ops.ts';
import type { LayoutOp } from '../../src/layout/types.ts';
import { SourceService } from '../../src/service/sourceService.ts';
import { VodService } from '../../src/service/vodService.ts';
import { BackupService } from '../../src/sync/backup.ts';
import { BackupError, openBackup } from '../../src/sync/backupCrypto.ts';
import { SyncClock } from '../../src/sync/clock.ts';
import type { SourceConfig } from '../../src/types.ts';

const T = Date.UTC(2026, 9, 20, 12);
const ITER = 1000;
const fetchNone = () => Promise.reject(new Error('no network in this test'));

/** One device: storage, services sharing one clock, and its BackupService. */
function device(node: string, now = () => T) {
  const storage = new MemoryStorage();
  const clock = new SyncClock({ storage, now, nodeId: () => node });
  const service = new SourceService({ storage, fetch: fetchNone, now, syncClock: clock });
  const vod = new VodService({ storage, fetch: fetchNone, now, syncClock: clock });
  const backup = new BackupService({
    storage, clock, now, iterations: ITER, vod,
    loadLayout: (id) => service.loadLayout(id),
    applyLayout: async (id, ops) => { await service.updateLayout(id, (l) => { const r = applyOps(l, ops); return r.changed ? r.layout : undefined; }); },
    getSettings: () => service.getSettings(),
    saveSettings: (patch) => service.saveSettings(patch, { stamp: false }),
  });
  const edit = async (id: string, ops: LayoutOp[]) => {
    const r = applyOps(await service.loadLayout(id), ops);
    await service.saveLayout(id, r.layout, r.touched);
  };
  return { storage, clock, service, vod, backup, edit };
}

const xtA: SourceConfig = { kind: 'xtream', id: 'a1', name: 'Mine', server: 'http://panel.example.test:8080', username: 'viewer01', password: 'pw-secret' };
const m3uA: SourceConfig = { kind: 'm3u', id: 'a2', name: 'Other', playlistUrl: 'https://lists.example.test/mine.m3u' };

async function deviceAWithState() {
  const a = device('nodeaa');
  await a.storage.putSource(xtA);
  await a.storage.putSource(m3uA);
  await a.edit('a1', [
    { op: 'createList', id: 'kids', name: 'Kids' },
    { op: 'addToList', listId: 'kids', channelIds: ['a1:x3'] },
    { op: 'addToList', listId: 'fav', channelIds: ['a1:x2'] },
    { op: 'hideChannels', ids: ['a1:x7'] },
    { op: 'renameChannel', id: 'a1:x1', name: 'Morning desk' },
    { op: 'markWatched', id: 'a1:x1' },
  ]);
  await a.edit('a2', [{ op: 'hideChannels', ids: ['a2:abcd1234-1'] }]);
  await a.vod.saveProgress('a1', 'a1:m1', 600_000, 7200_000);
  await a.vod.setFavourite('a1', 'a1:m1', true);
  await a.vod.setVodPick('a1', 'movie', 't:42', 'a1:m3');
  await a.service.saveSettings({ subtitleLanguage: 'sv', epgOffsetHours: 3 });
  return a;
}

describe('BackupService', () => {
  test('a backup made on one TV restores onto another TV with its own source ids', async () => {
    const a = await deviceAWithState();
    const made = await a.backup.create();
    expect(made.code).toHaveLength(26);
    expect(made.records).toBeGreaterThan(5);

    const b = device('nodebb');
    // The same account added on the new TV: another id, another password.
    await b.storage.putSource({ ...xtA, id: 'b9', password: 'changed', name: 'Living room' });
    const res = await b.backup.restore(made.envelope, made.code);
    expect(res.sources).toBe(1);
    expect(res.pending).toBe(1); // a2's hidden channel waits for its source
    const l = await b.service.loadLayout('b9');
    expect(l.lists.map((x) => [x.id, x.channelIds])).toEqual([['fav', ['b9:x2']], ['kids', ['b9:x3']]]);
    expect(l.hiddenChannels).toEqual(['b9:x7']);
    expect(l.channelNames).toEqual({ 'b9:x1': 'Morning desk' });
    expect(l.recent).toEqual([]);
    const m1 = await b.vod.getUser('b9', 'b9:m1');
    expect(m1).toMatchObject({ position: 600_000, duration: 7200_000, favourite: true, updatedAt: T });
    expect(await b.vod.getVodPicks('b9', 'movie')).toEqual({ 't:42': 'b9:m3' });
    const settings = await b.service.getSettings();
    expect(settings.subtitleLanguage).toBe('sv');
    expect(settings.epgOffsetHours).toBe(0); // device-tuned: never in a backup
    // The restored registers carry A's stamps, so B's next backup says the same.
    const clocks = await b.clock.clocks('b9');
    expect(clocks.get('hc:b9:x7')).toBe((await a.clock.clocks('a1')).get('hc:a1:x7'));

    // Restoring the same backup again changes nothing.
    const again = await b.backup.restore(made.envelope, made.code);
    expect(again.applied).toBe(0);
  });

  test('a newer edit on the restoring TV is kept', async () => {
    const a = await deviceAWithState();
    const made = await a.backup.create();
    let now = T + 60_000;
    const b = device('nodebb', () => now);
    await b.storage.putSource({ ...xtA, id: 'b9' });
    await b.edit('b9', [{ op: 'hideChannels', ids: ['b9:x7'] }, { op: 'unhideChannels', ids: ['b9:x7'] }]);
    await b.clock.idle();
    now = T + 120_000;
    await b.backup.restore(made.envelope, made.code);
    expect((await b.service.loadLayout('b9')).hiddenChannels).toEqual([]);
  });

  test('records of a source that is not on this TV wait, and apply when it is added', async () => {
    const a = await deviceAWithState();
    const made = await a.backup.create();
    const b = device('nodebb');
    await b.backup.restore(made.envelope, made.code);
    expect((await b.backup.pendingCount())).toBeGreaterThan(0);
    const added: SourceConfig = { ...m3uA, id: 'b3', playlistUrl: 'https://LISTS.example.test/mine.m3u#x' };
    await b.storage.putSource(added);
    expect(await b.backup.applyPending(added)).toBe(1);
    expect((await b.service.loadLayout('b3')).hiddenChannels).toEqual(['b3:abcd1234-1']);
    const xt: SourceConfig = { ...xtA, id: 'b9' };
    await b.storage.putSource(xt);
    expect(await b.backup.applyPending(xt)).toBeGreaterThan(3);
    expect((await b.service.loadLayout('b9')).hiddenChannels).toEqual(['b9:x7']);
    expect(await b.backup.applyPending(xt)).toBe(0);
  });

  test('a wrong code fails without changing anything', async () => {
    const a = await deviceAWithState();
    const made = await a.backup.create();
    const b = device('nodebb');
    await b.storage.putSource({ ...xtA, id: 'b9' });
    const other = made.code.startsWith('0') ? `1${made.code.slice(1)}` : `0${made.code.slice(1)}`;
    const err = await b.backup.restore(made.envelope, other).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).reason).toBe('wrongCode');
    expect((await b.service.loadLayout('b9')).hiddenChannels).toEqual([]);
  });

  test('the sealed snapshot is a payload: credentials, URLs and names never in it', async () => {
    const a = await deviceAWithState();
    const made = await a.backup.create();
    const json = new TextDecoder().decode((await openBackup(made.envelope, made.code)).plaintext);
    for (const needle of ['viewer01', 'pw-secret', 'panel.example.test', 'lists.example.test', '://', 'Mine', 'Other', 'recent']) {
      expect(json, needle).not.toContain(needle);
    }
    expect(JSON.parse(json)).toMatchObject({ v: 1, p: { v: 1 } });
  });
});
