import { describe, expect, it } from 'vitest';
import { PlaybackJournal } from '@iptv/player';
import { JOURNAL_KEY, createJournalPersist, pageLoadEvent } from './journalStore.ts';
import type { StorageLike } from './liveTargets.ts';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('journalStore', () => {
  it('saves under iptv.playbackJournal and loads it back in a new journal', () => {
    const m = memory();
    const a = new PlaybackJournal({ persist: createJournalPersist(() => m) });
    a.add({ k: 'stop', t: 5 });
    a.flush();
    expect(JSON.parse(m.data.get(JOURNAL_KEY)!)).toEqual({ v: 1, e: [{ k: 'stop', t: 5 }] });
    const b = new PlaybackJournal({ persist: createJournalPersist(() => m) });
    expect(b.entries()).toEqual([{ k: 'stop', t: 5 }]);
  });

  it('a throwing or missing storage behaves as empty and never throws', () => {
    const bad: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    const p = createJournalPersist(() => bad);
    expect(p.load()).toBeNull();
    expect(() => p.save('{}')).not.toThrow();
    const none = createJournalPersist(() => undefined);
    expect(none.load()).toBeNull();
    expect(() => none.save('{}')).not.toThrow();
  });

  it('pageLoadEvent reads the navigation type, and leaves it out when unknown', () => {
    const perf = (type: string) => ({ getEntriesByType: () => [{ type }] });
    expect(pageLoadEvent(9, perf('reload'))).toEqual({ k: 'page', t: 9, what: 'load', nav: 'reload' });
    expect(pageLoadEvent(9, perf('navigate'))).toEqual({ k: 'page', t: 9, what: 'load', nav: 'navigate' });
    expect(pageLoadEvent(9, perf('weird'))).toEqual({ k: 'page', t: 9, what: 'load' });
    expect(pageLoadEvent(9, undefined)).toEqual({ k: 'page', t: 9, what: 'load' });
    expect(pageLoadEvent(9, { getEntriesByType: () => { throw new Error('old engine'); } })).toEqual({ k: 'page', t: 9, what: 'load' });
  });
});
