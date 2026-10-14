import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearcher, resultsMessage, type SearchState } from './searchLogic.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

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

describe('resultsMessage', () => {
  const st = (p: Partial<SearchState<string>>): SearchState<string> => ({ query: 'xyz', results: [], busy: false, failed: false, ...p });
  it('covers each state', () => {
    expect(resultsMessage(st({ query: '' }))).toBe('Type to search channels');
    expect(resultsMessage(st({ busy: true }))).toBe('Searching…');
    expect(resultsMessage(st({}))).toBe('No channels match "xyz"');
    expect(resultsMessage(st({ results: ['a'] }))).toBeUndefined();
    expect(resultsMessage(st({ failed: true }))).toBe("Couldn't search right now.");
  });
});
