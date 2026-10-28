import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { ChannelIndex, type ChannelRegionView } from '../src/index/channelIndex.ts';
import { applyOps, emptyLayout, type LayoutOp } from '../src/layout/index.ts';
import { parseM3u, type M3uEntry } from '../src/m3u/parse.ts';
import { m3uEntriesToChannels } from '../src/m3u/toChannels.ts';
import { buildRegionsRecord, type GroupRegion } from '../src/text/regions.ts';
import type { Channel } from '../src/types.ts';

async function* lines(text: string) { for (const l of text.split(/\r?\n/)) yield l; }

let channels: Channel[];
let detected: Readonly<Record<string, GroupRegion>>;
beforeAll(async () => {
  const text = readFileSync(new URL('./fixtures/regions/fold.m3u', import.meta.url), 'utf8');
  const entries: M3uEntry[] = [];
  for await (const e of parseM3u(lines(text))) entries.push(e);
  channels = m3uEntriesToChannels('s', entries);
  detected = buildRegionsRecord(channels).groups;
});

const SE_NEWS = 'g:SE | Synthetic News';
const BE_NEWS = 'g:BE | Synthetic News';
const NORDIC = 'g:NORDIC';
const DE_DOCS = 'g:DE | Synthetic Docs';
const BE_KIDS = 'g:BE | Synthetic Kids';
const EN_FILMS = 'g:EN | Synthetic Films';
const MUSIC = 'g:Synthetic Music';
const WEEKLY = 'g:Synthetic Weekly (FI)';
const DK_KIDS = 'g:DK | Synthetic Kids';
const BE_DOCS = 'g:BE | Synthetic Docs';

const view = (mode: ChannelRegionView['mode'], codes: string[], fold = true): ChannelRegionView => ({ detected, mode, codes, fold });
const lay = (...ops: LayoutOp[]) => applyOps(emptyLayout(), ops).layout;
const index = (v: ChannelRegionView, l = emptyLayout()) => new ChannelIndex(channels, l, undefined, { regions: v });
/** Group ids in order; folded ones as `id@key`. */
const shape = (idx: ChannelIndex) => idx.groups().map((g) => (g.fold ? `${g.id}@${g.fold}` : g.id));
const NO_PICKS = [
  'all', 'fav',
  `${BE_NEWS}@BE`, `${BE_KIDS}@BE`, `${BE_DOCS}@BE`, `${SE_NEWS}@SE`, `${NORDIC}@SE`, `${DK_KIDS}@DK`, `${EN_FILMS}@lang:en`, `${DE_DOCS}@DE`,
  MUSIC, WEEKLY,
];

describe('ChannelIndex: your countries first, the rest folded by country', () => {
  test('no picks: countries fold after All channels, most folders first, ties by label; not-sure and no-country stay flat', () => {
    expect(shape(index(view('off', [])))).toEqual(NO_PICKS);
  });

  test('picks: Recently watched, All and the lists first, then chosen groups in pick order (a multi-key group by its best key)', () => {
    expect(shape(index(view('first', ['DK', 'SE'])))).toEqual([
      'all', 'fav', NORDIC, DK_KIDS, SE_NEWS,
      `${BE_NEWS}@BE`, `${BE_KIDS}@BE`, `${BE_DOCS}@BE`, `${EN_FILMS}@lang:en`, `${DE_DOCS}@DE`, MUSIC, WEEKLY,
    ]);
    const l = lay({ op: 'markWatched', id: channels[0]!.id });
    const ids = shape(index(view('first', ['DK']), l));
    expect(ids.slice(0, 5)).toEqual(['recent', 'all', 'fav', NORDIC, DK_KIDS]);
  });

  test('hand-moved groups come right after the lists and never fold', () => {
    const l = lay({ op: 'setGroupOrder', ids: [DE_DOCS, MUSIC] });
    expect(shape(index(view('first', ['SE']), l))).toEqual([
      'all', 'fav', DE_DOCS, MUSIC, SE_NEWS, NORDIC,
      `${BE_NEWS}@BE`, `${BE_KIDS}@BE`, `${BE_DOCS}@BE`, `${DK_KIDS}@DK`, `${EN_FILMS}@lang:en`, WEEKLY,
    ]);
  });

  test('only: nothing to fold (other countries are hidden by the rule)', () => {
    expect(shape(index(view('only', ['SE'])))).toEqual(['all', 'fav', SE_NEWS, NORDIC, MUSIC, WEEKLY]);
  });

  test('fold off: below yours, flat in provider order, as before', () => {
    const idx = index(view('first', ['SE'], false));
    expect(shape(idx)).toEqual(['all', 'fav', SE_NEWS, NORDIC, BE_NEWS, DE_DOCS, BE_KIDS, EN_FILMS, MUSIC, WEEKLY, DK_KIDS, BE_DOCS]);
    expect(idx.groups().find((g) => g.id === BE_NEWS)?.other).toBe(true);
  });

  test('fewer than two keys among non-hidden groups: no fold; hidden groups count nowhere', () => {
    const l = lay({ op: 'hideGroups', ids: [BE_NEWS, BE_KIDS, BE_DOCS, DE_DOCS, EN_FILMS, DK_KIDS, NORDIC] });
    expect(shape(index(view('off', []), l))).toEqual(['all', 'fav', SE_NEWS, MUSIC, WEEKLY]);
  });

  test('stale picks: the rule is off, so everyone gets the fold', () => {
    const idx = index(view('first', ['PL']));
    expect(idx.regionState()).toEqual({ mode: 'off', requested: 'first', stale: true });
    expect(shape(idx)).toEqual(NO_PICKS);
  });

  test('All channels and number zapping do not read roles', () => {
    const flat = new ChannelIndex(channels);
    const folded = index(view('first', ['DK']));
    expect(folded.slice('all', 0, 50)).toEqual(flat.slice('all', 0, 50));
    for (const c of channels) expect(folded.byNumber(c.number)?.id).toBe(flat.byNumber(c.number)?.id);
    expect(folded.neighbour('all', channels[3]!.id, 1)?.id).toBe(flat.neighbour('all', channels[3]!.id, 1)?.id);
  });

  test('withLayout keeps the fold', () => {
    const idx = index(view('off', []));
    expect(shape(idx.withLayout(lay({ op: 'renameGroup', id: MUSIC, name: 'Music' })))).toEqual(NO_PICKS);
  });
});
