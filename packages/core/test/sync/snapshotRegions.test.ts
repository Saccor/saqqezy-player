import { describe, expect, test } from 'vitest';
import { applyOps } from '../../src/layout/ops.ts';
import { emptyLayout } from '../../src/layout/types.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/settings.ts';
import { encodeHlc } from '../../src/sync/hlc.ts';
import { mergeRecords } from '../../src/sync/merge.ts';
import { decodePayload, encodePayload } from '../../src/sync/payload.ts';
import { exportSettings, exportSource, planSettingsRestore, planSourceRestore, registerMap, type SourceState } from '../../src/sync/snapshot.ts';
import type { SyncRecord } from '../../src/sync/types.ts';
import { applyVodOps, emptyVodLayout } from '../../src/vod/layout.ts';

/**
 * Wave 2 integration: a backup (S1) carries the Your countries state (regions branch): groups shown over the region
 * rule, the user's region per group, movie/series category hide/show/order, and the `regions` setting.
 */
const T = Date.UTC(2026, 9, 20, 12);
const FP = 'AAAAAAAAAAAAAAAAAAAAAA';
const st = (wall: number, node = 'nodeaa') => encodeHlc({ wall, counter: 0, node });

function deviceA(): SourceState {
  const layout = applyOps(emptyLayout(), [
    { op: 'showGroups', ids: ['g:DK | Synthetic Kids'] },
    { op: 'setGroupRegion', id: 'g:Synthetic Mixed', codes: ['SE', 'lang:sv'] },
    { op: 'setGroupRegion', id: 'g:Synthetic World', codes: [] },
  ]).layout;
  const movie = applyVodOps(emptyVodLayout(), 'movie', [
    { op: 'hideCategories', ids: ['c-11'] },
    { op: 'showCategories', ids: ['c-12'] },
    { op: 'setCategoryOrder', ids: ['c-13', 'c-11'] },
  ]).layout;
  const clocks = new Map<string, string>([
    ['sg:g:DK | Synthetic Kids', st(T - 5000)],
    ['sg:g:Synthetic Old', st(T - 4000)], // unshown later: a tombstone
    ['gr:g:Synthetic Cleared', st(T - 3000)], // back to detection: a tombstone
    ['ch:movie|c-19', st(T - 2000)], // unhidden later
    ['cq:movie', st(T - 1000)],
  ]);
  return {
    sourceId: 'a1', sfp: FP, layout, clocks, vodUser: [],
    picks: { movie: {}, series: {} }, splits: { movie: new Set(), series: new Set() },
    vodLayout: { movie, series: emptyVodLayout() },
  };
}

const bySid = (rs: SyncRecord[], k: string) => rs.filter((r) => r.k === k).map((r) => [r.ref.sid, r.v]);

describe('backup snapshot: Your countries state', () => {
  test('exports shown groups, group regions and category hide/show/order, with tombstones', () => {
    const rs = exportSource(deviceA(), { unstamped: 'synthetic' });
    expect(bySid(rs, 'sg').sort()).toEqual([['g:DK | Synthetic Kids', true], ['g:Synthetic Old', false]]);
    expect(bySid(rs, 'gr').sort()).toEqual([
      ['g:Synthetic Cleared', null], ['g:Synthetic Mixed', ['SE', 'lang:sv']], ['g:Synthetic World', []],
    ]);
    expect(bySid(rs, 'ch').sort()).toEqual([['movie|c-11', true], ['movie|c-19', false]]);
    expect(bySid(rs, 'cs')).toEqual([['movie|c-12', true]]);
    // An empty series layout says nothing; the movie order is carried.
    expect(bySid(rs, 'cq')).toEqual([['movie', ['c-13', 'c-11']]]);
    expect(rs.find((r) => r.k === 'cq')!.t).toBe(st(T - 1000));
    expect(decodePayload(JSON.parse(JSON.stringify(encodePayload(rs, T)))).length).toBe(rs.length);
  });

  test('restores them on another device under its own source id', () => {
    const remote = exportSource(deviceA(), { unstamped: 'synthetic' });
    const start = applyOps(emptyLayout(), [{ op: 'showGroups', ids: ['g:Synthetic Old'] }, { op: 'setGroupRegion', id: 'g:Synthetic Cleared', codes: ['DK'] }]).layout;
    const { apply } = mergeRecords(new Map(), remote, T);
    const plan = planSourceRestore('b9', start, apply);
    const l = applyOps(start, plan.ops).layout;
    expect(l.shownGroups).toEqual(['g:DK | Synthetic Kids']);
    expect(l.groupRegion).toEqual({ 'g:Synthetic Mixed': ['SE', 'lang:sv'], 'g:Synthetic World': [] });
    const movieOps = plan.vodLayout.find((x) => x.kind === 'movie')!.ops;
    const movie = applyVodOps(applyVodOps(emptyVodLayout(), 'movie', [{ op: 'hideCategories', ids: ['c-19'] }]).layout, 'movie', movieOps).layout;
    expect(movie.hiddenCategories).toEqual(['c-11']);
    expect(movie.shownCategories).toEqual(['c-12']);
    expect(movie.categoryOrder).toEqual(['c-13', 'c-11']);
    expect(plan.vodLayout.some((x) => x.kind === 'series')).toBe(false);
    expect(plan.stamps).toContainEqual({ key: 'sg:g:DK | Synthetic Kids', t: st(T - 5000) });
    expect(plan.stamps).toContainEqual({ key: 'ch:movie|c-19', t: st(T - 2000) });
    expect(plan.stamps).toContainEqual({ key: 'cq:movie', t: st(T - 1000) });
  });

  test('the regions setting travels in the payload shape and comes back as settings', () => {
    const settings = { ...DEFAULT_SETTINGS, regions: { mode: 'first' as const, codes: ['SE', 'lang:sv'] }, combineCategories: true };
    const rs = exportSettings(settings, new Map([['st:regions', st(T)]]), { unstamped: 'synthetic' });
    expect(rs.find((r) => r.ref.sid === 'regions')!.v).toEqual({ m: 'first', c: ['SE', 'lang:sv'] });
    const decoded = decodePayload(JSON.parse(JSON.stringify(encodePayload(rs, T))));
    expect(decoded.map((r) => r.ref.sid).sort()).toEqual(['combineCategories', 'regions']);
    const plan = planSettingsRestore(mergeRecords(new Map(), decoded, T).apply);
    expect(plan.patch.regions).toEqual({ mode: 'first', codes: ['SE', 'lang:sv'] });
    expect(plan.patch.combineCategories).toBe(true);
    // Merging against the same local value changes nothing.
    const local = registerMap(exportSettings(settings, new Map([['st:regions', st(T)]]), { unstamped: 'skip' }));
    expect(mergeRecords(local, decoded.filter((r) => r.ref.sid === 'regions'), T).apply).toEqual([]);
  });

  test('foldCountries is exported when stamped, restored, and an older payload without it keeps the default', () => {
    const rs = exportSettings({ ...DEFAULT_SETTINGS, foldCountries: false }, new Map([['st:foldCountries', st(T)]]), { unstamped: 'skip' });
    expect(rs.map((r) => [r.ref.sid, r.v])).toEqual([['foldCountries', false]]);
    const decoded = decodePayload(JSON.parse(JSON.stringify(encodePayload(rs, T))));
    expect(planSettingsRestore(mergeRecords(new Map(), decoded, T).apply).patch).toEqual({ foldCountries: false });
    // A payload from a build before the setting existed: no record, so the restore patch leaves it alone.
    const old = exportSettings({ ...DEFAULT_SETTINGS, regions: { mode: 'first', codes: ['SE'] } }, new Map([['st:regions', st(T)]]), { unstamped: 'skip' });
    const oldDecoded = decodePayload(JSON.parse(JSON.stringify(encodePayload(old, T))));
    const patch = planSettingsRestore(mergeRecords(new Map(), oldDecoded, T).apply).patch;
    expect('foldCountries' in patch).toBe(false);
    expect(sanitizeSettings(patch).foldCountries).toBe(true);
    // Settings stored by an older build (no key) read back with the default.
    expect(sanitizeSettings({ regions: { mode: 'first', codes: ['SE'] } }).foldCountries).toBe(true);
  });
});
