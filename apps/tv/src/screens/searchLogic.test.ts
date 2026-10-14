import type { ChannelRow, SearchResult } from '@iptv/app-api';
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
  rerunsSearch,
  resultsMessage,
  scrollAnchor,
  selectableCount,
  type SearchRow,
  type SearchState,
} from './searchLogic.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

const row = (n: number): ChannelRow => ({ id: `s:${n}`, number: n, name: `Channel ${n}`, group: 'G', favourite: false });
const result = (over: Partial<SearchResult> = {}): SearchResult => ({ channels: [], onNow: [], later: [], guidePending: false, ...over });
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
    expect(resultsMessage(st({ query: '' }))).toBe('Type to search channels and programmes');
    expect(resultsMessage(st({ busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({}))).toBe('No channels or programmes match "xyz"');
    expect(resultsMessage(st({ results: [chRow(1)] }))).toBeUndefined();
    expect(resultsMessage(st({ failed: true }))).toBe("Couldn't search right now.");
  });

  it('says the guide is being prepared when nothing matches yet and the guide is pending', () => {
    const pending = flattenResults(result({ guidePending: true }));
    expect(resultsMessage(st({ results: pending }))).toBe('No channels match "xyz" · Guide results are being prepared');
    expect(resultsMessage(st({ results: pending, busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({ results: flattenResults(result({ channels: [row(1)], guidePending: true })) }))).toBeUndefined();
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
