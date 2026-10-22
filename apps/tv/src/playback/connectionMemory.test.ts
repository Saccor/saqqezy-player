import { describe, expect, it } from 'vitest';
import { createConnectionMemory } from './connectionMemory.ts';

function store() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

describe('connectionMemory', () => {
  it('keeps the lowest window count a source refused at, and the most seen playing', () => {
    const s = store();
    const m = createConnectionMemory(() => s);
    expect(m.refusedAt('src')).toBeUndefined();
    m.learn('src', 3);
    m.learn('src', 2);
    m.learn('src', 4);
    expect(m.refusedAt('src')).toBe(2);
    m.seen('src', 2);
    m.seen('src', 1);
    expect(m.maxSeen('src')).toBe(2);
    expect(m.maxSeen('other')).toBe(0);
  });

  it('a cut verdict caps the most seen at the count it proves: an overcount from a window about to be cut is undone', () => {
    const m = createConnectionMemory(() => store());
    m.seen('src', 2);
    m.capSeen('src', 1);
    expect(m.maxSeen('src')).toBe(1);
    m.capSeen('src', 3); // a cap never raises it
    expect(m.maxSeen('src')).toBe(1);
    m.capSeen('other', 1);
    expect(m.maxSeen('other')).toBe(0);
  });

  it('survives a reload, stores numbers by source id only, and ignores junk', () => {
    const s = store();
    createConnectionMemory(() => s).learn('src', 2);
    expect(createConnectionMemory(() => s).refusedAt('src')).toBe(2);
    expect([...s.data.values()].join('')).toMatch(/^[{}":,\w\d]*$/);
    s.data.set('iptv.connections', 'not json');
    expect(createConnectionMemory(() => s).refusedAt('src')).toBeUndefined();
    expect(createConnectionMemory(() => undefined).refusedAt('src')).toBeUndefined();
  });
});
