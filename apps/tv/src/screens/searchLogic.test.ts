import type { ChannelRow, FolderHit, SearchResult, VodTile } from '@iptv/app-api';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import {
  channelToPlay,
  clampSearchFocus,
  createSearchMemory,
  createSearcher,
  focusedCell,
  FOLDERS_ROW_LABEL,
  hiddenRoute,
  liveRowLabel,
  folderCount,
  folderRoute,
  GUIDE_PENDING_NOTE,
  laterRoute,
  moveSearch,
  NO_ROWS,
  pendingNotes,
  programmeContext,
  rerunsSearch,
  resultsMessage,
  SEARCH_ROW_ORDER,
  searchRows,
  searchingNote,
  settleFocus,
  VOD_PENDING_NOTE,
  VOD_ROW_LABEL,
  vodRoute,
  vodRowModel,
  type LiveCell,
  type SearchRows,
  type SearchState,
} from './searchLogic.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

const row = (n: number): ChannelRow => ({ id: `s:${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false });
const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  channels: [], channelTotal: over.channels?.length ?? 0, hiddenCount: 0, onNow: [], later: [], guidePending: false, folders: [], movies: [],
  series: [], vodPending: false, ...over,
});
const tile = (kind: 'movie' | 'series', n: number, extra: Partial<VodTile> = {}): VodTile => ({
  id: `s:${kind[0]}${n}`, kind, title: `Synthetic ${kind} ${n}`, categoryId: '1', watched: false, favourite: false, ...extra,
});

const folder = (n: number, kind: FolderHit['kind'] = 'live', count = 3): FolderHit => ({ kind, id: kind === 'live' ? `g:Folder ${n}` : `cat${n}`, name: `Folder ${n}`, count });

describe('createSearcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (run: (q: string) => Promise<string[]>) => {
    const states: SearchState<string[]>[] = [];
    const s = createSearcher(run, (st) => states.push(st), { empty: [] });
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

describe('channel totals and hidden groups', () => {
  test('a card for matches in hidden groups after the channels, before the programmes; it opens Your countries', () => {
    const r = searchRows(result({ channels: [row(1)], hiddenCount: 4, onNow: [{ channel: row(2), title: 'Now 2', start: 0, stop: 1 }] }));
    expect(r.live.map((c) => c.type)).toEqual(['channel', 'hidden', 'programme']);
    expect(r.live[1]).toEqual({ type: 'hidden', count: 4 });
    expect(hiddenRoute(r.live[1])).toEqual({ screen: 'settings', params: { page: 'countries' } });
    expect(hiddenRoute(r.live[0])).toBeUndefined();
    expect(channelToPlay(r.live[1])).toBeUndefined();
    expect(searchRows(result({ channels: [row(1)] })).live.map((c) => c.type)).toEqual(['channel']);
  });

  test('the live row label counts the channels, and says when more matched than are shown', () => {
    expect(liveRowLabel(searchRows(result()))).toBe('Live & guide');
    expect(liveRowLabel(searchRows(result({ channels: [row(1)] })))).toBe('Live & guide · 1 channel');
    expect(liveRowLabel(searchRows(result({ channels: [row(1), row(2)], channelTotal: 340 })))).toBe('Live & guide · 2 of 340 channels');
  });
});

describe('searchRows', () => {
  const now = (n: number) => ({ channel: row(n), title: `Now ${n}`, start: 0, stop: 1 });
  const later = (n: number) => ({ title: `Later ${n}`, channel: row(n), start: 2, stop: 3, more: 0 });

  test('movies before series in the VOD row', () => {
    const r = searchRows(result({ movies: [tile('movie', 1), tile('movie', 2)], series: [tile('series', 1)] }));
    expect(r.vod).toEqual([tile('movie', 1), tile('movie', 2), tile('series', 1)]);
    expect(r.live).toEqual([]);
  });

  test('channels, then on now, then later in the live row', () => {
    const r = searchRows(result({ channels: [row(1)], onNow: [now(2)], later: [later(3)] }));
    expect(r.live).toEqual([
      { type: 'channel', channel: row(1) },
      { type: 'programme', when: 'onNow', hit: now(2) },
      { type: 'programme', when: 'later', hit: later(3) },
    ]);
    expect(r.vod).toEqual([]);
  });

  test('folders become folder cells in their own row, in result order', () => {
    const r = searchRows(result({ folders: [folder(1), folder(2, 'movie')] }));
    expect(r.folders).toEqual([{ type: 'folder', hit: folder(1) }, { type: 'folder', hit: folder(2, 'movie') }]);
    expect(NO_ROWS.folders).toEqual([]);
    expect(SEARCH_ROW_ORDER).toEqual(['vod', 'folders', 'live']);
    expect(FOLDERS_ROW_LABEL).toBe('Folders');
  });

  test('carries the pending flags', () => {
    expect(searchRows(result({ guidePending: true }))).toEqual({ ...NO_ROWS, guidePending: true });
    expect(searchRows(result({ vodPending: true })).vodPending).toBe(true);
    expect(searchRows(result())).toEqual(NO_ROWS);
  });

  test('pending notes: the guide first, then movies and series', () => {
    expect(pendingNotes(searchRows(result({ guidePending: true, vodPending: true })))).toEqual([GUIDE_PENDING_NOTE, VOD_PENDING_NOTE]);
    expect(pendingNotes(searchRows(result({ vodPending: true })))).toEqual([VOD_PENDING_NOTE]);
    expect(pendingNotes(NO_ROWS)).toEqual([]);
  });

  test('the VOD row as a poster row model: loaded, no View all', () => {
    const r = searchRows(result({ movies: [tile('movie', 1)], series: [tile('series', 1)] }));
    expect(vodRowModel(r)).toEqual({ id: 'search-vod', title: VOD_ROW_LABEL, total: 2, items: r.vod, loaded: true });
  });

  test('the focused cell of each row', () => {
    const r = searchRows(result({ channels: [row(1)], movies: [tile('movie', 1)] }));
    expect(focusedCell(r, { area: 'vod', col: 0 })).toEqual({ type: 'vod', tile: tile('movie', 1) });
    expect(focusedCell(r, { area: 'live', col: 0 })).toEqual({ type: 'channel', channel: row(1) });
    expect(focusedCell(r, { area: 'live', col: 5 })).toBeUndefined();
    expect(focusedCell(r, { area: 'keyboard', col: 0 })).toBeUndefined();
  });
});

describe('programmeContext', () => {
  const at = (h: number, m = 0, day = 20) => new Date(2026, 9, day, h, m).getTime();
  test('on now: the time range and the channel', () => {
    const c: LiveCell = { type: 'programme', when: 'onNow', hit: { channel: row(4), title: 'X', start: at(20), stop: at(21, 30) } };
    expect(programmeContext(c, at(20, 10))).toBe('20:00–21:30 · Channel 4');
  });
  test('later: the day and start time, the channel, and further airings', () => {
    const hit = { channel: row(5), title: 'Y', start: at(9, 5, 21), stop: at(10, 0, 21), more: 0 };
    expect(programmeContext({ type: 'programme', when: 'later', hit }, at(20))).toBe('Tomorrow 09:05 · Channel 5');
    expect(programmeContext({ type: 'programme', when: 'later', hit: { ...hit, more: 2 } }, at(20))).toBe('Tomorrow 09:05 · Channel 5 · +2 more');
  });
});

describe('moveSearch', () => {
  test('Up and Down walk vod, folders, live; an empty folders row is skipped; the keyboard goes to the first non-empty row', () => {
    const three = searchRows(result({ movies: [tile('movie', 1)], folders: [folder(1), folder(2)], channels: [row(1)] }));
    expect(moveSearch({ area: 'vod', col: 0 }, 'down', three)).toEqual({ area: 'folders', col: 0 });
    expect(moveSearch({ area: 'folders', col: 1 }, 'down', three)).toEqual({ area: 'live', col: 0 });
    expect(moveSearch({ area: 'live', col: 0 }, 'up', three)).toEqual({ area: 'folders', col: 0 });
    expect(moveSearch({ area: 'folders', col: 1 }, 'up', three)).toEqual({ area: 'vod', col: 0 });
    const noFolders = searchRows(result({ movies: [tile('movie', 1)], channels: [row(1)] }));
    expect(moveSearch({ area: 'vod', col: 0 }, 'down', noFolders)).toEqual({ area: 'live', col: 0 });
    const onlyFolders = searchRows(result({ folders: [folder(1)] }));
    expect(moveSearch({ area: 'keyboard', col: 0 }, 'right', onlyFolders)).toEqual({ area: 'folders', col: 0 });
    expect(focusedCell(three, { area: 'folders', col: 1 })).toEqual({ type: 'folder', hit: folder(2) });
  });

  const both = searchRows(result({ movies: [tile('movie', 1), tile('movie', 2), tile('movie', 3)], channels: [row(1), row(2)] }));
  const liveOnly = searchRows(result({ channels: [row(1), row(2)] }));
  const vodOnly = searchRows(result({ movies: [tile('movie', 1)] }));

  test('Left and Right move along a row and stop at its end', () => {
    expect(moveSearch({ area: 'vod', col: 1 }, 'right', both)).toEqual({ area: 'vod', col: 2 });
    expect(moveSearch({ area: 'vod', col: 2 }, 'right', both)).toEqual({ area: 'vod', col: 2 });
    expect(moveSearch({ area: 'vod', col: 2 }, 'left', both)).toEqual({ area: 'vod', col: 1 });
  });

  test('Up and Down move between non-empty rows, keeping the column where it fits', () => {
    expect(moveSearch({ area: 'vod', col: 1 }, 'down', both)).toEqual({ area: 'live', col: 1 });
    expect(moveSearch({ area: 'vod', col: 2 }, 'down', both)).toEqual({ area: 'live', col: 1 });
    expect(moveSearch({ area: 'live', col: 0 }, 'up', both)).toEqual({ area: 'vod', col: 0 });
    expect(moveSearch({ area: 'vod', col: 0 }, 'up', both)).toEqual({ area: 'vod', col: 0 });
    expect(moveSearch({ area: 'live', col: 1 }, 'down', both)).toEqual({ area: 'live', col: 1 });
  });

  test('an empty row is skipped: Up and Down stay put', () => {
    expect(moveSearch({ area: 'live', col: 1 }, 'up', liveOnly)).toEqual({ area: 'live', col: 1 });
    expect(moveSearch({ area: 'vod', col: 0 }, 'down', vodOnly)).toEqual({ area: 'vod', col: 0 });
  });

  test('Left at column 0 goes to the keyboard', () => {
    expect(moveSearch({ area: 'vod', col: 0 }, 'left', both)).toBe('keyboard');
    expect(moveSearch({ area: 'live', col: 0 }, 'left', both)).toBe('keyboard');
  });

  test("the keyboard's right edge goes to the first non-empty row; its left edge to the rail", () => {
    expect(moveSearch({ area: 'keyboard', col: 0 }, 'right', both)).toEqual({ area: 'vod', col: 0 });
    expect(moveSearch({ area: 'keyboard', col: 0 }, 'right', liveOnly)).toEqual({ area: 'live', col: 0 });
    expect(moveSearch({ area: 'keyboard', col: 0 }, 'right', NO_ROWS)).toBe('keyboard');
    expect(moveSearch({ area: 'keyboard', col: 0 }, 'left', both)).toBe('rail');
  });
});

describe('clampSearchFocus', () => {
  test('an emptied folders row gives way to the live row, then the vod row, then the keyboard', () => {
    expect(clampSearchFocus({ area: 'folders', col: 2 }, searchRows(result({ channels: [row(1)] })))).toEqual({ area: 'live', col: 0 });
    expect(clampSearchFocus({ area: 'folders', col: 2 }, searchRows(result({ movies: [tile('movie', 1)] })))).toEqual({ area: 'vod', col: 0 });
    expect(clampSearchFocus({ area: 'folders', col: 2 }, NO_ROWS)).toEqual({ area: 'keyboard', col: 0 });
  });

  const liveOnly = searchRows(result({ channels: [row(1), row(2)] }));
  test('a focus on a row that emptied moves to the other row, or to the keyboard', () => {
    expect(clampSearchFocus({ area: 'vod', col: 3 }, liveOnly)).toEqual({ area: 'live', col: 1 });
    expect(clampSearchFocus({ area: 'live', col: 1 }, NO_ROWS)).toEqual({ area: 'keyboard', col: 0 });
    expect(clampSearchFocus({ area: 'live', col: 9 }, liveOnly)).toEqual({ area: 'live', col: 1 });
    expect(clampSearchFocus({ area: 'keyboard', col: 0 }, liveOnly)).toEqual({ area: 'keyboard', col: 0 });
  });
});

describe('settleFocus', () => {
  const later = (n: number) => ({ title: `S${n}`, channel: row(n + 10), start: 2, stop: 3, more: 0 });
  const full = searchRows(result({ movies: [tile('movie', 1)], channels: [row(1), row(2), row(3)], later: [0, 1, 2, 3, 4].map(later) }));
  const pending = searchRows(result({ channels: [row(1), row(2), row(3)], guidePending: true }));
  const base = {
    returning: false, memory: { area: 'live' as const, col: 6 }, current: { area: 'keyboard' as const, col: 0 }, query: 'sh', settledQuery: '',
  };

  it('a new query keeps the keyboard focused', () => {
    expect(settleFocus({ ...base, rows: full })).toEqual({ focus: { area: 'keyboard', col: 0 }, consumeReturning: false });
  });

  it('a new query while in a row starts that row at column 0', () => {
    expect(settleFocus({ ...base, rows: full, current: { area: 'live', col: 4 } })).toEqual({ focus: { area: 'live', col: 0 }, consumeReturning: false });
  });

  it('a re-run of the same query keeps the focused cell', () => {
    expect(settleFocus({ ...base, rows: full, current: { area: 'live', col: 4 }, settledQuery: 'sh' }))
      .toEqual({ focus: { area: 'live', col: 4 }, consumeReturning: false });
  });

  it('returning restores the saved area and column at once on a full answer', () => {
    expect(settleFocus({ ...base, rows: full, returning: true })).toEqual({ focus: { area: 'live', col: 6 }, consumeReturning: true });
  });

  it('a pending answer while returning sets a provisional focus and keeps returning', () => {
    expect(settleFocus({ ...base, rows: pending, returning: true })).toEqual({ focus: { area: 'live', col: 2 }, consumeReturning: false });
  });

  it('an empty answer while returning keeps the current focus and keeps returning', () => {
    expect(settleFocus({ ...base, rows: NO_ROWS, returning: true })).toEqual({ focus: { area: 'keyboard', col: 0 }, consumeReturning: false });
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
  const st = (p: Partial<SearchState<SearchRows>>): SearchState<SearchRows> => ({ query: 'xyz', results: NO_ROWS, busy: false, failed: false, ...p });
  it('covers each state', () => {
    expect(resultsMessage(st({ query: '' }))).toBe('Type to search channels, folders, programmes, movies and series');
    expect(resultsMessage(st({ busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({}))).toBe('Nothing matches "xyz"');
    expect(resultsMessage(st({ results: searchRows(result({ channels: [row(1)] })) }))).toBeUndefined();
    expect(resultsMessage(st({ results: searchRows(result({ movies: [tile('movie', 1)] })) }))).toBeUndefined();
    expect(resultsMessage(st({ failed: true }))).toBe("Couldn't search right now.");
  });

  it('says the guide is being prepared when nothing matches yet and the guide is pending', () => {
    const pending = searchRows(result({ guidePending: true }));
    expect(resultsMessage(st({ results: pending }))).toBe('Nothing matches "xyz" · Guide results are being prepared');
    expect(resultsMessage(st({ results: pending, busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({ results: searchRows(result({ channels: [row(1)], guidePending: true })) }))).toBeUndefined();
  });

  it('says movies and series are being prepared when only they are pending', () => {
    expect(resultsMessage(st({ results: searchRows(result({ vodPending: true })) }))).toBe('Nothing matches "xyz" · Movies and series are being prepared');
    expect(resultsMessage(st({ results: searchRows(result({ guidePending: true, vodPending: true })) })))
      .toBe('Nothing matches "xyz" · Guide results are being prepared');
  });
});

describe('searchingNote', () => {
  const st = (p: Partial<SearchState<SearchRows>>): SearchState<SearchRows> => ({ query: 'xyz', results: NO_ROWS, busy: false, failed: false, ...p });
  const some = searchRows(result({ channels: [row(1)] }));
  it('shows while a query runs over the shown rows only', () => {
    expect(searchingNote(st({ busy: true, results: some }))).toBe('Searching…');
    expect(searchingNote(st({ busy: false, results: some }))).toBeUndefined();
    // No rows: the results message says Searching… instead.
    expect(searchingNote(st({ busy: true }))).toBeUndefined();
  });
});

describe('what Ok does', () => {
  test('a movie or series opens the detail screen of its kind with the tile', () => {
    const m = tile('movie', 1);
    const s = tile('series', 2);
    expect(vodRoute({ type: 'vod', tile: m })).toEqual({ screen: 'movieDetail', params: { id: m.id, tile: m } });
    expect(vodRoute({ type: 'vod', tile: s })).toEqual({ screen: 'seriesDetail', params: { id: s.id, tile: s } });
    expect(vodRoute({ type: 'channel', channel: row(1) })).toBeUndefined();
    expect(vodRoute(undefined)).toBeUndefined();
  });

  test('a folder opens Live TV at that folder, or the grid at that category; other cells do not', () => {
    expect(folderRoute({ type: 'folder', hit: folder(1) })).toEqual({ screen: 'home', params: { groupId: 'g:Folder 1' } });
    expect(folderRoute({ type: 'folder', hit: folder(2, 'series') })).toEqual({ screen: 'vodGrid', params: { kind: 'series', categoryId: 'cat2' } });
    expect(folderRoute({ type: 'channel', channel: row(1) })).toBeUndefined();
    expect(channelToPlay({ type: 'folder', hit: folder(1) })).toBeUndefined();
    expect(vodRoute({ type: 'folder', hit: folder(1) })).toBeUndefined();
  });

  test('folderCount: singular and plural per kind', () => {
    expect(folderCount(folder(1, 'live', 1))).toBe('1 channel');
    expect(folderCount(folder(1, 'live', 214))).toBe('214 channels');
    expect(folderCount(folder(1, 'movie', 1))).toBe('1 movie');
    expect(folderCount(folder(1, 'movie', 38))).toBe('38 movies');
    expect(folderCount(folder(1, 'series', 1))).toBe('1 series');
    expect(folderCount(folder(1, 'series', 12))).toBe('12 series');
  });

  test('a coming-up programme returns to Live TV at that channel and time; other cells do not', () => {
    const hit = { title: 'Later Show', channel: row(7), start: 1_700_000_000_000, stop: 1_700_000_360_000, more: 0 };
    expect(laterRoute({ type: 'programme', when: 'later', hit })).toEqual({ screen: 'home', params: { channelId: 's:7', at: 1_700_000_000_000 } });
    expect(laterRoute({ type: 'channel', channel: row(1) })).toBeUndefined();
    expect(laterRoute(undefined)).toBeUndefined();
  });

  test('a channel or an on-now programme plays its channel', () => {
    expect(channelToPlay({ type: 'channel', channel: row(1) })).toEqual(row(1));
    expect(channelToPlay({ type: 'programme', when: 'onNow', hit: { channel: row(2), title: 'N', start: 0, stop: 1 } })).toEqual(row(2));
    expect(channelToPlay({ type: 'programme', when: 'later', hit: { channel: row(3), title: 'L', start: 0, stop: 1, more: 0 } })).toBeUndefined();
    expect(channelToPlay({ type: 'vod', tile: tile('movie', 1) })).toBeUndefined();
    expect(channelToPlay(undefined)).toBeUndefined();
  });
});

describe('stable results while searching', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the previous results visible while the next query is busy', async () => {
    const states: SearchState<string[]>[] = [];
    const s = createSearcher(async (q: string) => [`${q}-hit`], (st) => states.push(st), { empty: [] });
    s.setQuery('a');
    vi.advanceTimersByTime(150);
    await flush();
    s.setQuery('ab');
    expect(states[states.length - 1]).toEqual({ query: 'ab', results: ['a-hit'], busy: true, failed: false });
    vi.advanceTimersByTime(150);
    await flush();
    expect(states[states.length - 1]).toEqual({ query: 'ab', results: ['ab-hit'], busy: false, failed: false });
  });
});

describe('search memory', () => {
  it('Back to the previous screen forgets the query, the position and the returning flag', () => {
    const m = createSearchMemory();
    m.query = 'abc';
    m.leaveTo({ area: 'live', col: 4 });
    m.leaveBack();
    expect({ query: m.query, area: m.area, col: m.col, returning: m.returning }).toEqual({ query: '', area: 'keyboard', col: 0, returning: false });
  });

  it('opening a result keeps the query, the area and the column, and sets returning (round trip)', () => {
    const m = createSearchMemory();
    m.query = 'abc';
    m.leaveTo({ area: 'vod', col: 3 });
    expect({ query: m.query, area: m.area, col: m.col, returning: m.returning }).toEqual({ query: 'abc', area: 'vod', col: 3, returning: true });
    const rows = searchRows(result({ movies: [1, 2, 3, 4, 5].map((n) => tile('movie', n)) }));
    const d = settleFocus({
      rows, returning: m.returning, memory: { area: m.area, col: m.col }, current: { area: 'keyboard', col: 0 }, query: 'abc', settledQuery: '',
    });
    expect(d).toEqual({ focus: { area: 'vod', col: 3 }, consumeReturning: true });
  });

  it('a key handled in the results cancels a pending restore, so the user position wins', () => {
    const m = createSearchMemory();
    m.query = 'abc';
    m.leaveTo({ area: 'live', col: 2 });
    m.userNavigated();
    expect(m.returning).toBe(false);
    const rows = searchRows(result({ channels: [row(1), row(2), row(3)] }));
    const d = settleFocus({
      rows, returning: m.returning, memory: { area: m.area, col: m.col }, current: { area: 'live', col: 1 }, query: 'abc', settledQuery: 'abc',
    });
    expect(d).toEqual({ focus: { area: 'live', col: 1 }, consumeReturning: false });
  });
});

