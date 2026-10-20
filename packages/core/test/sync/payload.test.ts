import { describe, expect, test } from 'vitest';
import type { Channel, Programme, SourceConfig } from '../../src/types.ts';
import type { VodList } from '../../src/vod/types.ts';
import { encodeHlc } from '../../src/sync/hlc.ts';
import {
  DELTA_MAX_BYTES, SNAPSHOT_MAX_BYTES, SYNCED_SETTINGS, decodePayload, encodePayload, payloadBytes,
} from '../../src/sync/payload.ts';
import type { SyncRecord, SyncValue } from '../../src/sync/types.ts';

const T = Date.UTC(2026, 9, 20, 12);
const DAY = 24 * 3600_000;
const t = (wall: number, node = 'nodeaa', counter = 0) => encodeHlc({ wall, counter, node });
const FP = 'AAAAAAAAAAAAAAAAAAAAAA';
const FP2 = 'BBBBBBBBBBBBBBBBBBBBBB';
const rec = (k: SyncRecord['k'], sid: string, v: SyncValue, opts: { pk?: string; sfp?: string; wall?: number; node?: string } = {}): SyncRecord => {
  const ref: SyncRecord['ref'] = { sfp: opts.sfp ?? FP, sid };
  if (opts.pk !== undefined) ref.pk = opts.pk;
  return { k, ref, t: t(opts.wall ?? T, opts.node), v };
};

const sample: SyncRecord[] = [
  rec('vp', 'm1', { p: 600_000, d: 7200_000, w: false }, { pk: 't:42' }),
  rec('vp', 'e7', { p: 0, d: 2400_000, w: true, s: { id: 's5', se: 1, ep: 2, n: { id: 'e8', se: 1, ep: 3 } } }, { pk: 'y:synthetic series|2020|S1E2' }),
  rec('vf', 'm1', true, { pk: 't:42' }),
  rec('vt', 'm1', { a: 'eng', s: 'swe' }),
  rec('vk', 'movie', 'm2', { pk: 't:42' }),
  rec('vs', 'series', false, { pk: 'n:synthetic' }),
  rec('hc', 'x101', true),
  rec('hc', 'x102', false, { node: 'nodebb' }),
  rec('hg', 'g:Synthetic News', true),
  rec('lm', 'fav|x101', true),
  rec('lq', 'fav', ['x101', 'x103']),
  rec('ln', 'kids', 'Kids'),
  rec('ln', 'old', null),
  rec('lo', '', ['kids']),
  rec('cn', 'x101', 'Morning desk'),
  rec('gn', 'g:Synthetic News', null),
  rec('go', '', ['g:Synthetic News', 'g:Film']),
  rec('co', 'g:Film', null),
  rec('so', 'g:Film', 'name'),
  rec('ne', '', false),
  rec('st', 'subtitleLanguage', 'swe', { sfp: '' }),
  rec('st', 'preferredLanguages', ['swe', 'eng'], { sfp: '' }),
  rec('st', 'combineDuplicates', true, { sfp: '' }),
  rec('vf', 'm9', true, { sfp: FP2, pk: 't:7' }),
];

const sortRecs = (rs: SyncRecord[]) => [...rs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('sync payload', () => {
  test('round trip of every record kind', () => {
    const p = encodePayload(sample, T);
    expect(p.v).toBe(1);
    expect(sortRecs(decodePayload(JSON.parse(JSON.stringify(p))))).toEqual(sortRecs(sample));
  });

  test('stamps are shared: a bulk change costs one stamp', () => {
    const p = encodePayload([rec('hc', 'x1', true), rec('hc', 'x2', true), rec('hc', 'x3', true)], T);
    expect(p.c).toHaveLength(1);
    expect(p.n).toEqual(['nodeaa']);
  });

  test('tombstones older than 90 days are left out', () => {
    const p = encodePayload([rec('hc', 'x1', false, { wall: T - 91 * DAY }), rec('hc', 'x2', false, { wall: T - 10 * DAY }), rec('hc', 'x3', true, { wall: T - 400 * DAY })], T);
    expect(decodePayload(p).map((r) => r.ref.sid).sort()).toEqual(['x2', 'x3']);
  });

  test('only the §6.3 settings sync; device-tuned and local ones never do', () => {
    expect([...SYNCED_SETTINGS].sort()).toEqual([
      'audioLanguage', 'combineDuplicates', 'followedTeams', 'hiddenCompetitions', 'pinnedCompetitions', 'preferredLanguages', 'regions', 'subtitleLanguage',
    ]);
    const local = ['epgOffsetHours', 'preferredFormat', 'liveDelay', 'showClock', 'sleepTimerMinutes', 'openOn', 'posterSize', 'volume', 'recent'];
    const p = encodePayload(local.map((k) => rec('st', k, 1 as unknown as SyncValue, { sfp: '' })), T);
    expect(decodePayload(p)).toEqual([]);
  });

  test('decoding drops anything outside the closed schema', () => {
    const good = encodePayload([rec('hc', 'x1', true)], T);
    const tampered = {
      ...good,
      channels: [{ id: 'x1' }],
      s: {
        ...good.s,
        [FP]: {
          ...good.s[FP],
          zz: [['x9', 0, 1]],
          hg: [['g:A', 0, { nested: true }], ['g:B', 9, 1], ['g:C', 0, 1, 'pk', 'extra'], ['g:D', 0, 1]],
          cn: [['x1', 0, 'x'.repeat(61)], ['x2', 0, 'http://example.test/live.ts'], ['x3', 0, 42], ['x4', 0, 'Fine']],
          vp: [['m1', 0, { p: 1, d: 2, w: false, url: 'http://example.test/m1.mkv' }], ['m2', 0, { p: -1, d: 2, w: false }]],
          vt: [['m1', 0, { a: 'eng', title: 'Synthetic Film' }]],
          go: [['', 0, [{ id: 'x' }]], ['', 0, ['g:A', 'rtmp://example.test/a']]],
        },
        'not a fingerprint': { hc: [['x1', 0, 1]] },
      },
    };
    const out = decodePayload(tampered);
    expect(sortRecs(out)).toEqual(sortRecs([rec('hc', 'x1', true), rec('hg', 'g:D', true), rec('cn', 'x4', 'Fine')]));
    expect(decodePayload(null)).toEqual([]);
    expect(decodePayload({ v: 2, n: [], c: [], s: {} })).toEqual([]);
    expect(decodePayload({ v: 1, n: ['BAD'], c: ['00000000000000'], s: {} })).toEqual([]);
  });

  test('no Channel[], catalogue or programme data can enter a payload', () => {
    const channels: Channel[] = [
      { id: 'a1:x101', sourceId: 'a1', name: 'Synthetic News HD', url: 'http://stream.example.test/live/101.ts', group: 'Synthetic', number: 1, logo: 'http://img.example.test/101.png' } as Channel,
    ];
    const vod: VodList = { items: [{ id: 'a1:m1', kind: 'movie', title: 'Synthetic Film 01', categoryId: '1', url: 'http://stream.example.test/movie/1.mkv' }], categories: [{ id: '1', kind: 'movie', name: 'Synthetic Drama', count: 1 }] };
    const programmes: Programme[] = [{ epgId: 'synthetic.news', start: T, stop: T + 3600_000, title: 'Synthetic Morning Show', desc: 'A synthetic description.' } as Programme];
    const source: SourceConfig = { kind: 'xtream', id: 'a1', name: 'Mine', server: 'panel.example.test', username: 'viewer01', password: 'pw-secret' };
    const smuggled = [
      // Whole objects in value slots.
      { ...rec('hc', 'x101', true), v: channels[0] },
      { ...rec('vp', 'm1', { p: 1, d: 2, w: false }), v: { ...vod.items[0], p: 1, d: 2, w: false } },
      { ...rec('go', '', []), v: channels },
      { ...rec('lq', 'fav', []), v: programmes.map((p) => p.title) as string[] },
      { ...rec('st', 'subtitleLanguage', 'swe', { sfp: '' }), v: source },
      // Extra fields beside a valid record, on the record and on its ref.
      { ...rec('hc', 'x102', true), channels, vod, programmes, source },
      { ...rec('vf', 'm1', true), ref: { sfp: FP, sid: 'm1', url: vod.items[0]!.url, title: 'Synthetic Film 01' } },
      // URLs as ids or names.
      rec('cn', 'x101', channels[0]!.url),
      rec('hc', channels[0]!.url, true),
    ] as unknown as SyncRecord[];
    const json = JSON.stringify(encodePayload(smuggled, T));
    for (const needle of ['Synthetic News HD', 'stream.example.test', 'img.example.test', 'Synthetic Film 01', 'Synthetic Drama', 'synthetic.news', 'pw-secret', 'viewer01', 'panel.example.test', '://']) {
      expect(json, needle).not.toContain(needle);
    }
    expect(json).not.toContain('Synthetic Morning Show');
    // The two valid records (x102 hidden, m1 favourite) survive without their passengers.
    expect(decodePayload(JSON.parse(json)).map((r) => `${r.k}:${r.ref.sid}`).sort()).toEqual(['hc:x102', 'vf:m1']);
  });

  test('the value type admits no catalogue objects', () => {
    const ch = { id: 'x', sourceId: 's', name: 'n', url: 'u', group: 'g', number: 1 } as Channel;
    // @ts-expect-error a Channel is not a sync value
    const bad: SyncValue = ch;
    // @ts-expect-error nor is a list of them
    const bad2: SyncValue = [ch];
    expect([bad, bad2]).toHaveLength(2);
  });
});

describe('sync payload size (budgeted uncompressed: CompressionStream is Chromium 80+)', () => {
  const ids = Array.from({ length: 50_000 }, (_, i) => `x${100_000 + i}`);

  test('50k hidden channels hidden in one action fit a snapshot with room to spare', () => {
    const p = encodePayload(ids.map((id) => rec('hc', id, true)), T);
    const bytes = payloadBytes(p);
    expect(bytes).toBeLessThan(SNAPSHOT_MAX_BYTES / 2);
    expect(decodePayload(JSON.parse(JSON.stringify(p)))).toHaveLength(50_000);
  });

  test('50k hidden channels with 50k distinct stamps from two devices still fit the 2 MB snapshot', () => {
    const p = encodePayload(ids.map((id, i) => rec('hc', id, i % 3 !== 0, { wall: T - i * 1000, node: i % 2 ? 'nodeaa' : 'nodebb' })), T);
    expect(p.c.length).toBe(50_000);
    expect(payloadBytes(p)).toBeLessThan(SNAPSHOT_MAX_BYTES);
  });

  test('a typical delta (one progress save, a favourite) is far below the 64 KB delta cap', () => {
    const p = encodePayload([sample[0]!, sample[2]!], T);
    expect(payloadBytes(p)).toBeLessThan(DELTA_MAX_BYTES / 100);
  });
});
