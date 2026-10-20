import { describe, expect, test } from 'vitest';
import { applyOps } from '../../src/layout/ops.ts';
import { emptyLayout, type Layout } from '../../src/layout/types.ts';
import { DEFAULT_SETTINGS } from '../../src/settings.ts';
import { encodeHlc, hlcWall } from '../../src/sync/hlc.ts';
import { mergeRecords } from '../../src/sync/merge.ts';
import { decodePayload, encodePayload } from '../../src/sync/payload.ts';
import {
  SYNTHETIC_NODE, exportSettings, exportSource, isSyntheticStamp, planSettingsRestore, planSourceRestore, registerMap,
  type SourceState,
} from '../../src/sync/snapshot.ts';
import { registerKey, type SyncRecord } from '../../src/sync/types.ts';
import type { VodUserRecord } from '../../src/vod/types.ts';

const T = Date.UTC(2026, 9, 20, 12);
const FP = 'AAAAAAAAAAAAAAAAAAAAAA';
const st = (wall: number, node = 'nodeaa') => encodeHlc({ wall, counter: 0, node });

/** Device A: source `a1`, a synthetic playlist. */
function deviceA(): SourceState {
  const ops = applyOps(emptyLayout(), [
    { op: 'createList', id: 'kids', name: 'Kids' },
    { op: 'addToList', listId: 'kids', channelIds: ['a1:x3', 'a1:x1'] },
    { op: 'addToList', listId: 'fav', channelIds: ['a1:x2'] },
    { op: 'hideChannels', ids: ['a1:x7', 'a1:x8'] },
    { op: 'hideGroups', ids: ['g:Synthetic Shopping'] },
    { op: 'renameChannel', id: 'a1:x1', name: 'Morning desk' },
    { op: 'renameGroup', id: 'g:Synthetic News', name: 'News' },
    { op: 'setGroupOrder', ids: ['g:Synthetic News', 'g:Synthetic Film'] },
    { op: 'setChannelOrder', groupId: 'g:Synthetic Film', ids: ['a1:x5', 'a1:x4'] },
    { op: 'setSort', groupId: 'all', mode: 'name' },
    { op: 'setHideNoEpg', value: true },
    { op: 'markWatched', id: 'a1:x1' },
  ]);
  const clocks = new Map<string, string>([
    ['hc:a1:x7', st(T - 5000)],
    ['hc:a1:x9', st(T - 4000)], // unhidden later: a tombstone
    ['cn:a1:x4', st(T - 3000)], // rename removed
    ['ln:old', st(T - 2000)], // list deleted
    ['lm:fav|a1:x6', st(T - 1000)], // removed from Favourites
    ['ne:', st(T - 500)],
    ['vf:a1:m2', st(T - 400)], // un-favourited
  ]);
  const vodUser: VodUserRecord[] = [
    { itemId: 'a1:m1', state: { position: 600_000, duration: 7200_000, watched: false, favourite: true, updatedAt: T - 60_000, audio: 'eng' } },
    { itemId: 'a1:m2', state: { position: 0, duration: 0, watched: false, favourite: false, updatedAt: 0 } },
    {
      itemId: 'a1:e7',
      state: { position: 0, duration: 2400_000, watched: true, favourite: false, updatedAt: T - 30_000, series: { id: 'a1:s5', season: 1, episode: 2, next: { id: 'a1:e8', season: 1, episode: 3 } } },
    },
  ];
  return {
    sourceId: 'a1', sfp: FP, layout: ops.layout, clocks, vodUser,
    picks: { movie: { 't:42': 'a1:m3' }, series: {} }, splits: { movie: new Set(['n:synthetic']), series: new Set() },
  };
}

const bySid = (rs: SyncRecord[], k: string) => rs.filter((r) => r.k === k).map((r) => [r.ref.sid, r.v]);

describe('snapshot export', () => {
  test('exports every synced register, with tombstones from clocks and synthetic stamps for unstamped state', () => {
    const rs = exportSource(deviceA(), { unstamped: 'synthetic' });
    expect(rs.every((r) => r.ref.sfp === FP)).toBe(true);
    expect(bySid(rs, 'hc').sort()).toEqual([['x7', true], ['x8', true], ['x9', false]]);
    expect(rs.find((r) => r.k === 'hc' && r.ref.sid === 'x7')!.t).toBe(st(T - 5000));
    expect(isSyntheticStamp(rs.find((r) => r.k === 'hc' && r.ref.sid === 'x8')!.t)).toBe(true);
    expect(bySid(rs, 'hg')).toEqual([['g:Synthetic Shopping', true]]);
    expect(bySid(rs, 'lm').sort()).toEqual([['fav|x2', true], ['fav|x6', false], ['kids|x1', true], ['kids|x3', true]]);
    expect(bySid(rs, 'lq').sort()).toEqual([['fav', ['x2']], ['kids', ['x3', 'x1']]]);
    expect(bySid(rs, 'ln').sort()).toEqual([['kids', 'Kids'], ['old', null]]); // an unstamped default (Favourites' name) is left out
    expect(bySid(rs, 'lo')).toEqual([['', ['fav', 'kids']]]);
    expect(bySid(rs, 'cn').sort()).toEqual([['x1', 'Morning desk'], ['x4', null]]);
    expect(bySid(rs, 'gn')).toEqual([['g:Synthetic News', 'News']]);
    expect(bySid(rs, 'go')).toEqual([['', ['g:Synthetic News', 'g:Synthetic Film']]]);
    expect(bySid(rs, 'co')).toEqual([['g:Synthetic Film', ['x5', 'x4']]]);
    expect(bySid(rs, 'so')).toEqual([['all', 'name']]);
    expect(bySid(rs, 'ne')).toEqual([['', true]]);
    expect(rs.find((r) => r.k === 'ne')!.t).toBe(st(T - 500));
    // VOD: progress with its series pointer (sids), favourites (and an un-favourite), tracks, picks, splits.
    expect(bySid(rs, 'vp').sort()).toEqual([
      ['e7', { p: 0, d: 2400_000, w: true, s: { id: 's5', se: 1, ep: 2, n: { id: 'e8', se: 1, ep: 3 } } }],
      ['m1', { p: 600_000, d: 7200_000, w: false }],
    ]);
    // Unstamped progress carries its updatedAt as the stamp's wall time (Continue watching keeps its order).
    expect(hlcWall(rs.find((r) => r.k === 'vp' && r.ref.sid === 'm1')!.t)).toBe(T - 60_000);
    expect(bySid(rs, 'vf').sort()).toEqual([['m1', true], ['m2', false]]);
    expect(bySid(rs, 'vt')).toEqual([['m1', { a: 'eng' }]]);
    expect(rs.filter((r) => r.k === 'vk').map((r) => [r.ref.sid, r.ref.pk, r.v])).toEqual([['movie', 't:42', 'm3']]);
    expect(rs.filter((r) => r.k === 'vs').map((r) => [r.ref.sid, r.ref.pk, r.v])).toEqual([['movie', 'n:synthetic', true]]);
    // `recent` (markWatched) stays local.
    expect(JSON.stringify(rs)).not.toContain('recent');
    // Everything fits the closed payload schema.
    expect(decodePayload(JSON.parse(JSON.stringify(encodePayload(rs, T)))).length).toBe(rs.length);
  });

  test('unstamped: skip leaves out what no clock stamped (local registers for a merge)', () => {
    const rs = exportSource(deviceA(), { unstamped: 'skip' });
    expect(rs.map((r) => `${r.k}:${r.ref.sid}`).sort()).toEqual(['cn:x4', 'hc:x7', 'hc:x9', 'lm:fav|x6', 'ln:old', 'ne:', 'vf:m2']);
  });

  test('settings: only the synced subset, stamped from the settings clocks', () => {
    const settings = { ...DEFAULT_SETTINGS, subtitleLanguage: 'swe', preferredLanguages: ['swe'], epgOffsetHours: 2 };
    const rs = exportSettings(settings, new Map([['st:subtitleLanguage', st(T)]]), { unstamped: 'synthetic' });
    expect(rs.every((r) => r.k === 'st' && r.ref.sfp === '')).toBe(true);
    // Unstamped defaults (audio, combineDuplicates, followedTeams) are left out; device-tuned epgOffsetHours never syncs.
    expect(rs.map((r) => r.ref.sid).sort()).toEqual(['preferredLanguages', 'subtitleLanguage']);
    expect(rs.find((r) => r.ref.sid === 'subtitleLanguage')!.t).toBe(st(T));
    expect(exportSettings(settings, new Map([['st:subtitleLanguage', st(T)]]), { unstamped: 'skip' }).map((r) => r.ref.sid)).toEqual(['subtitleLanguage']);
  });
});

describe('restore plan', () => {
  /** Restores A's export onto device B (source `b9`, nothing stamped) the way BackupService does. */
  const restoreOnto = (layout: Layout, local: SyncRecord[] = []) => {
    const remote = exportSource(deviceA(), { unstamped: 'synthetic' });
    const { apply } = mergeRecords(registerMap(local), remote, T);
    const plan = planSourceRestore('b9', layout, apply);
    return { plan, next: applyOps(layout, plan.ops) };
  };

  test('rebuilds the layout on another device under its own source id', () => {
    const { plan, next } = restoreOnto(emptyLayout());
    expect(next.rejected).toEqual([]);
    const l = next.layout;
    expect(l.lists.map((x) => [x.id, x.name, x.channelIds])).toEqual([['fav', 'Favourites', ['b9:x2']], ['kids', 'Kids', ['b9:x3', 'b9:x1']]]);
    expect([...l.hiddenChannels].sort()).toEqual(['b9:x7', 'b9:x8']);
    expect(l.hiddenGroups).toEqual(['g:Synthetic Shopping']);
    expect(l.channelNames).toEqual({ 'b9:x1': 'Morning desk' });
    expect(l.groupNames).toEqual({ 'g:Synthetic News': 'News' });
    expect(l.groupOrder).toEqual(['g:Synthetic News', 'g:Synthetic Film']);
    expect(l.channelOrder).toEqual({ 'g:Synthetic Film': ['b9:x5', 'b9:x4'] });
    expect(l.sort).toEqual({ all: 'name' });
    expect(l.hideNoEpg).toBe(true);
    expect(l.recent).toEqual([]);
    // VOD under the new source id; picks and splits too.
    expect(plan.vod.map((v) => v.itemId).sort()).toEqual(['b9:e7', 'b9:m1', 'b9:m2']);
    const m1 = plan.vod.find((v) => v.itemId === 'b9:m1')!;
    expect(m1.progress).toEqual({ position: 600_000, duration: 7200_000, watched: false, updatedAt: T - 60_000 });
    expect(m1.favourite).toBe(true);
    expect(m1.tracks).toEqual({ a: 'eng' });
    expect(plan.vod.find((v) => v.itemId === 'b9:e7')!.progress!.series).toEqual({ id: 'b9:s5', season: 1, episode: 2, next: { id: 'b9:e8', season: 1, episode: 3 } });
    expect(plan.picks).toEqual([{ kind: 'movie', key: 't:42', itemId: 'b9:m3' }]);
    expect(plan.splits).toEqual([{ kind: 'movie', key: 'n:synthetic', on: true }]);
    // Real stamps are adopted under local clock keys; synthetic ones are not (the state stays unstamped).
    expect(plan.stamps).toContainEqual({ key: 'hc:b9:x7', t: st(T - 5000) });
    expect(plan.stamps).toContainEqual({ key: 'lm:fav|b9:x6', t: st(T - 1000) });
    expect(plan.stamps.some((s) => s.key === 'hc:b9:x8')).toBe(false);
  });

  test('a list deleted on A goes on B; tombstones remove; restoring twice changes nothing', () => {
    const start = applyOps(emptyLayout(), [
      { op: 'createList', id: 'old', name: 'Old' },
      { op: 'addToList', listId: 'fav', channelIds: ['b9:x6'] },
      { op: 'hideChannels', ids: ['b9:x9'] },
      { op: 'renameChannel', id: 'b9:x4', name: 'Was renamed' },
    ]).layout;
    const once = restoreOnto(start).next.layout;
    expect(once.lists.map((x) => x.id)).toEqual(['fav', 'kids']);
    expect(once.lists[0]!.channelIds).toEqual(['b9:x2']);
    expect(once.hiddenChannels).not.toContain('b9:x9');
    expect(once.channelNames['b9:x4']).toBeUndefined();
    const again = planSourceRestore('b9', once, mergeRecords(new Map(), exportSource(deviceA(), { unstamped: 'synthetic' }), T).apply);
    expect(applyOps(once, again.ops).changed).toBe(false);
  });

  test('a newer local write wins over the backup', () => {
    const newer = [{ k: 'ne', ref: { sfp: FP, sid: '' }, t: st(T, 'nodebb'), v: false } as SyncRecord];
    const { next } = restoreOnto(emptyLayout(), newer);
    expect(next.layout.hideNoEpg).toBe(false);
  });

  test('settings winners become one patch of the synced subset', () => {
    const remote = exportSettings({ ...DEFAULT_SETTINGS, subtitleLanguage: 'swe', epgOffsetHours: 5 }, new Map(), { unstamped: 'synthetic' });
    const { apply } = mergeRecords(new Map(), remote, T);
    const plan = planSettingsRestore(apply);
    expect(plan.patch.subtitleLanguage).toBe('swe');
    expect('epgOffsetHours' in plan.patch).toBe(false);
    expect(plan.stamps).toEqual([]);
  });

  test('registerMap keys records by register', () => {
    const r = { k: 'hc', ref: { sfp: FP, sid: 'x1' }, t: st(T), v: true } as SyncRecord;
    expect([...registerMap([r]).keys()]).toEqual([registerKey(r)]);
    expect(SYNTHETIC_NODE).toBe('000000');
  });
});
