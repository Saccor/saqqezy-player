import type { ChannelRow, SearchResult, VodTile } from '@iptv/app-api';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import {
  countText,
  listTop,
  createSearchMemory,
  createSearcher,
  flattenResults,
  GUIDE_PENDING_NOTE,
  isSelectable,
  listRows,
  nextFocus,
  rerunsSearch,
  resultsMessage,
  scrollAnchor,
  selectableCount,
  vodLine,
  vodRoute,
  VOD_PENDING_NOTE,
  type SearchRow,
  type SearchState,
} from './searchLogic.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

const row = (n: number): ChannelRow => ({ id: `s:${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false });
const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  channels: [], onNow: [], later: [], guidePending: false, movies: [], series: [], vodPending: false, ...over,
});
const tile = (kind: 'movie' | 'series', n: number, extra: Partial<VodTile> = {}): VodTile => ({
  id: `s:${kind[0]}${n}`, kind, title: `Synthetic ${kind} ${n}`, categoryId: '1', watched: false, favourite: false, ...extra,
});
const chRow = (n: number): SearchRow => ({ kind: 'channel', channel: row(n) });

describe('createSearcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (run: (q: string) => Promise<string[]>) => {
    const states: SearchState<string>[] = [];
    const s = createSearcher(run, (st) => states.push(st));
    return { s, states, last: () => states[states.length - 1]! };
  };

  it('searches once, 150 ms after the last keystroke', async () => {
    const run = vi.fn(async (q: string) => [q]);
    const { s, last } = setup(run);
    s.setQuery('c');
    vi.advanceTimersByTime(100);
    s.setQuery('ch');
    vi.advanceTimersByTime(149);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('ch');
    await flush();
    expect(last()).toEqual({ query: 'ch', results: ['ch'], busy: false, failed: false });
  });

  it('drops a stale answer that arrives after a newer query', async () => {
    const pending = new Map<string, (r: string[]) => void>();
    const run = (q: string) => new Promise<string[]>((res) => pending.set(q, res));
    const { s, last } = setup(run);
    s.setQuery('a');
    vi.advanceTimersByTime(150);
    s.setQuery('ab');
    vi.advanceTimersByTime(150);
    pending.get('ab')!(['new']);
    await flush();
    pending.get('a')!(['old']);
    await flush();
    expect(last().results).toEqual(['new']);
  });

  it('clears immediately for an empty query and never searches', async () => {
    const run = vi.fn(async () => ['x']);
    const { s, last } = setup(run);
    s.setQuery('a');
    s.setQuery('   ');
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    expect(last()).toEqual({ query: '', results: [], busy: false, failed: false });
  });

  it('reports a failure only for the latest query', async () => {
    const { s, last } = setup(async () => { throw new Error('x'); });
    s.setQuery('a');
    vi.advanceTimersByTime(150);
    await flush();
    expect(last()).toMatchObject({ query: 'a', failed: true, busy: false });
  });

  it('ignores answers after dispose', async () => {
    const { s, states } = setup(async () => ['x']);
    s.setQuery('a');
    vi.advanceTimersByTime(150);
    const n = states.length;
    s.dispose();
    await flush();
    expect(states.length).toBe(n);
  });
});

describe('flattenResults', () => {
  test('sections in order with headers; empty sections omitted', () => {
    const rows = flattenResults(result({
      channels: [row(1)],
      later: [{ title: 'Later Show', channel: row(2), start: 2, stop: 3, more: 0 }],
    }));
    expect(rows.map((r) => r.kind)).toEqual(['header', 'channel', 'header', 'later']);
    expect(rows[0]).toEqual({ kind: 'header', label: 'Channels' });
    expect(rows[2]).toEqual({ kind: 'header', label: 'Coming up' });
  });

  test('on now sits between channels and coming up', () => {
    const rows = flattenResults(result({
      channels: [row(1)],
      onNow: [{ channel: row(3), title: 'Now Show', start: 0, stop: 1 }],
      later: [{ title: 'Later Show', channel: row(2), start: 2, stop: 3, more: 1 }],
    }));
    expect(rows.filter((r) => r.kind === 'header').map((r) => (r as { label: string }).label)).toEqual(['Channels', 'On now', 'Coming up']);
  });

  test('movies and series follow channels, before the programme sections', () => {
    const rows = flattenResults(result({
      channels: [row(1)],
      movies: [tile('movie', 1), tile('movie', 2)],
      series: [tile('series', 1)],
      onNow: [{ channel: row(3), title: 'Now Show', start: 0, stop: 1 }],
    }));
    expect(rows.filter((r) => r.kind === 'header').map((r) => (r as { label: string }).label)).toEqual(['Channels', 'Movies', 'Series', 'On now']);
    expect(rows.map((r) => r.kind)).toEqual(['header', 'channel', 'header', 'vod', 'vod', 'header', 'vod', 'header', 'onNow']);
    expect(rows[3]).toEqual({ kind: 'vod', tile: tile('movie', 1) });
    expect(rows.map(isSelectable)).toEqual([false, true, false, true, true, false, true, false, true]);
  });

  test('a pending movie and series index adds its note (after the guide one)', () => {
    expect(flattenResults(result({ channels: [row(1)], vodPending: true })).at(-1)).toEqual({ kind: 'note', label: VOD_PENDING_NOTE });
    expect(flattenResults(result({ guidePending: true, vodPending: true }))).toEqual([
      { kind: 'note', label: GUIDE_PENDING_NOTE }, { kind: 'note', label: VOD_PENDING_NOTE },
    ]);
  });

  test('pending note after the results, and on its own when nothing is selectable', () => {
    expect(flattenResults(result({ channels: [row(1)], guidePending: true })).at(-1)).toEqual({ kind: 'note', label: GUIDE_PENDING_NOTE });
    expect(flattenResults(result({ guidePending: true }))).toEqual([{ kind: 'note', label: GUIDE_PENDING_NOTE }]);
    expect(flattenResults(result({}))).toEqual([]);
  });

  test('listRows shows rows only when something is selectable', () => {
    const lone = flattenResults(result({ guidePending: true }));
    expect(listRows(lone)).toEqual([]);
    const some = flattenResults(result({ channels: [row(1)], guidePending: true }));
    expect(listRows(some)).toBe(some);
  });

  test('selectable rows exclude headers and notes', () => {
    const rows = flattenResults(result({ channels: [row(1), row(2)], guidePending: true }));
    expect(rows.map(isSelectable)).toEqual([false, true, true, false]);
    expect(selectableCount(rows)).toBe(2);
    expect(isSelectable(undefined)).toBe(false);
  });
});

describe('nextFocus', () => {
  const later = (n: number) => ({ title: `Show ${n}`, channel: row(n), start: 2, stop: 3, more: 0 });
  // Full answer: header, 3 channels, header, 20 coming-up rows (rows 0..25).
  const full = flattenResults(result({ channels: [row(1), row(2), row(3)], later: Array.from({ length: 20 }, (_, i) => later(i + 10)) }));
  // The same query while the guide index is loading: channels and the pending note only.
  const pending = flattenResults(result({ channels: [row(1), row(2), row(3)], guidePending: true }));
  const base = { returning: false, memoryFocus: 0, prevFocus: 0, query: 'sh', settledQuery: '', viewRows: 9 };

  it('a fresh query goes to the first selectable row at the top', () => {
    expect(nextFocus({ ...base, rows: full, prevFocus: 7 })).toEqual({ focus: 1, top: 0, consumeReturning: false, focusList: false });
  });

  it('a plain re-run of the same query keeps the focused row and the scroll', () => {
    expect(nextFocus({ ...base, rows: full, prevFocus: 7, settledQuery: 'sh' })).toEqual({ focus: 7, consumeReturning: false, focusList: false });
  });

  it('a pending answer while returning sets a provisional focus and keeps returning', () => {
    const d = nextFocus({ ...base, rows: pending, returning: true, memoryFocus: 20, settledQuery: '' });
    expect(d.consumeReturning).toBe(false);
    expect(d.focus).toBe(3);
    expect(d.focusList).toBe(true);
  });

  it('the full answer after a pending one restores the saved row exactly', () => {
    const provisional = nextFocus({ ...base, rows: pending, returning: true, memoryFocus: 20 });
    const d = nextFocus({ ...base, rows: full, returning: true, memoryFocus: 20, prevFocus: provisional.focus, settledQuery: 'sh' });
    expect(d).toEqual({ focus: 20, top: 12, consumeReturning: true, focusList: true });
  });

  it('a full answer while returning restores at once', () => {
    expect(nextFocus({ ...base, rows: full, returning: true, memoryFocus: 6 })).toEqual({ focus: 6, top: 0, consumeReturning: true, focusList: true });
  });

  it('an answer still waiting for movies and series only sets a provisional focus too', () => {
    const vodPending = flattenResults(result({ channels: [row(1), row(2), row(3)], vodPending: true }));
    const d = nextFocus({ ...base, rows: vodPending, returning: true, memoryFocus: 20 });
    expect(d.consumeReturning).toBe(false);
    expect(d.focus).toBe(3);
  });

  it('an empty or failed answer is safe and keeps returning', () => {
    expect(nextFocus({ ...base, rows: [] })).toEqual({ focus: 0, top: 0, consumeReturning: false, focusList: false });
    expect(nextFocus({ ...base, rows: [], returning: true, memoryFocus: 20 })).toEqual({ focus: 0, top: 0, consumeReturning: false, focusList: false });
    const lone = flattenResults(result({ guidePending: true }));
    expect(nextFocus({ ...base, rows: lone, returning: true, memoryFocus: 20, settledQuery: 'sh' })).toEqual({ focus: 0, top: 0, consumeReturning: false, focusList: false });
  });
});

describe('rerunsSearch', () => {
  it('re-runs on searchReady and on a finished guide import, not on a playlist refresh', () => {
    expect(rerunsSearch({ type: 'searchReady', sourceId: 's1' })).toBe(true);
    expect(rerunsSearch({ type: 'refreshed', what: 'epg', sourceId: 's1' })).toBe(true);
    expect(rerunsSearch({ type: 'refreshed', what: 'playlist', sourceId: 's1' })).toBe(false);
  });
});

describe('resultsMessage', () => {
  const st = (p: Partial<SearchState<SearchRow>>): SearchState<SearchRow> => ({ query: 'xyz', results: [], busy: false, failed: false, ...p });
  it('covers each state', () => {
    expect(resultsMessage(st({ query: '' }))).toBe('Type to search channels, programmes, movies and series');
    expect(resultsMessage(st({ busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({}))).toBe('Nothing matches "xyz"');
    expect(resultsMessage(st({ results: [chRow(1)] }))).toBeUndefined();
    expect(resultsMessage(st({ failed: true }))).toBe("Couldn't search right now.");
  });

  it('says the guide is being prepared when nothing matches yet and the guide is pending', () => {
    const pending = flattenResults(result({ guidePending: true }));
    expect(resultsMessage(st({ results: pending }))).toBe('No channels match "xyz" · Guide results are being prepared');
    expect(resultsMessage(st({ results: pending, busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({ results: flattenResults(result({ channels: [row(1)], guidePending: true })) }))).toBeUndefined();
  });

  it('says movies and series are being prepared when only they are pending', () => {
    const pending = flattenResults(result({ vodPending: true }));
    expect(resultsMessage(st({ results: pending }))).toBe('No channels match "xyz" · Movies and series are being prepared');
    expect(resultsMessage(st({ results: flattenResults(result({ guidePending: true, vodPending: true })) })))
      .toBe('No channels match "xyz" · Guide results are being prepared');
  });
});

describe('movie and series rows', () => {
  test('Ok opens the detail screen of the kind with the tile', () => {
    const m = tile('movie', 1);
    const s = tile('series', 2);
    expect(vodRoute({ kind: 'vod', tile: m })).toEqual({ screen: 'movieDetail', params: { id: m.id, tile: m } });
    expect(vodRoute({ kind: 'vod', tile: s })).toEqual({ screen: 'seriesDetail', params: { id: s.id, tile: s } });
    expect(vodRoute({ kind: 'channel', channel: row(1) })).toBeUndefined();
    expect(vodRoute(undefined)).toBeUndefined();
  });

  test('a compact line: title, then year when known', () => {
    expect(vodLine(tile('movie', 1, { year: 2004 }))).toBe('Synthetic movie 1 · 2004');
    expect(vodLine(tile('series', 1))).toBe('Synthetic series 1');
  });
});

describe('stable results while searching', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the previous results visible while the next query is busy', async () => {
    const states: SearchState<string>[] = [];
    const s = createSearcher(async (q: string) => [`${q}-hit`], (st) => states.push(st));
    s.setQuery('a');
    vi.advanceTimersByTime(150);
    await flush();
    s.setQuery('ab');
    expect(states[states.length - 1]).toEqual({ query: 'ab', results: ['a-hit'], busy: true, failed: false });
    vi.advanceTimersByTime(150);
    await flush();
    expect(states[states.length - 1]).toEqual({ query: 'ab', results: ['ab-hit'], busy: false, failed: false });
  });

  it('countText shows a subtle Searching… while busy, otherwise the count', () => {
    expect(countText({ query: 'a', results: [chRow(1)], busy: true, failed: false })).toBe('Searching…');
    expect(countText({ query: 'a', results: [], busy: true, failed: false })).toBe('');
    expect(countText({ query: 'a', results: [chRow(1)], busy: false, failed: false })).toBe('1 result');
    expect(countText({ query: 'a', results: [chRow(1), chRow(2)], busy: false, failed: false })).toBe('2 results');
    expect(countText({ query: '', results: [], busy: false, failed: false })).toBe('');
  });

  it('countText counts selectable rows only, not headers or notes', () => {
    const rows: SearchRow[] = [{ kind: 'header', label: 'Channels' }, chRow(1), { kind: 'note', label: GUIDE_PENDING_NOTE }];
    expect(countText({ query: 'a', results: rows, busy: false, failed: false })).toBe('1 result');
  });
});

describe('search memory', () => {
  it('Back to the previous screen forgets the query and the returning flag', () => {
    const m = createSearchMemory();
    m.query = 'abc'; m.focus = 4; m.returning = true;
    m.leaveBack();
    expect({ query: m.query, focus: m.focus, returning: m.returning }).toEqual({ query: '', focus: 0, returning: false });
  });

  it('going to the Player or Guide keeps the query, the focused row and sets returning', () => {
    const m = createSearchMemory();
    m.query = 'abc';
    m.leaveTo(3);
    expect({ query: m.query, focus: m.focus, returning: m.returning }).toEqual({ query: 'abc', focus: 3, returning: true });
  });

  it('a key handled in the results cancels a pending restore, so the user position wins', () => {
    const m = createSearchMemory();
    m.query = 'abc';
    m.leaveTo(20);
    m.userNavigated();
    expect({ query: m.query, focus: m.focus, returning: m.returning }).toEqual({ query: 'abc', focus: 20, returning: false });
    // The following full answer then keeps the user's row (a plain re-run), not the saved one.
    const rows = flattenResults(result({ channels: [row(1), row(2), row(3)] }));
    const d = nextFocus({ rows, returning: m.returning, memoryFocus: m.focus, prevFocus: 2, query: 'abc', settledQuery: 'abc', viewRows: 9 });
    expect(d.focus).toBe(2);
    expect(d.consumeReturning).toBe(false);
  });
});

describe('scrollAnchor and listTop', () => {
  const hdr = (label: string): SearchRow => ({ kind: 'header', label });
  const rows: SearchRow[] = [hdr('Channels'), chRow(1), chRow(2), chRow(3), hdr('On now'), chRow(4), chRow(5)];

  it('anchors on the header just above the focused row', () => {
    expect(scrollAnchor(rows, 1)).toBe(0);
    expect(scrollAnchor(rows, 5)).toBe(4);
  });
  it('anchors on the row itself when no header sits above it', () => {
    expect(scrollAnchor(rows, 2)).toBe(2);
    expect(scrollAnchor(rows, 0)).toBe(0);
  });
  it('scrolling up reveals the header above the first row of a section', () => {
    expect(listTop(rows, 1, 1, 3)).toBe(0);
    expect(listTop(rows, 5, 5, 3)).toBe(4);
  });
  it('scrolling down keeps the focused row visible and never passes the end', () => {
    expect(listTop(rows, 6, 0, 3)).toBe(4);
    expect(listTop(rows, 3, 0, 3)).toBe(1);
  });
  it('does not move when the focus is inside the window', () => {
    expect(listTop(rows, 2, 1, 3)).toBe(1);
  });
});
