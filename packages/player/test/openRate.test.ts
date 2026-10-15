import { describe, expect, it } from 'vitest';
import { DEFAULT_OPEN_RATE, SourceOpenRate, type OpenRateStore } from '../src/openRate.ts';

const memoryStore = (): OpenRateStore & { data: string | undefined } => {
  const s = { data: undefined as string | undefined, load: () => s.data, save: (v: string) => { s.data = v; } };
  return s;
};

describe('SourceOpenRate', () => {
  it('allows max opens per window and says how long to wait for the next', () => {
    let t = 0;
    const r = new SourceOpenRate({ rules: [{ max: 2, windowMs: 1000 }], now: () => t });
    expect(r.waitMs('s')).toBe(0);
    r.take('s');
    t = 100;
    r.take('s');
    expect(r.waitMs('s')).toBe(900); // until the first open leaves the window
    expect(r.waitMs('other')).toBe(0);
    t = 1000;
    expect(r.waitMs('s')).toBe(0);
  });

  it('every rule must have room; the wait is the longest', () => {
    let t = 0;
    const r = new SourceOpenRate({ rules: [{ max: 2, windowMs: 100 }, { max: 3, windowMs: 1000 }], now: () => t });
    for (const at of [0, 10, 200]) { t = at; r.take('s'); }
    t = 300;
    expect(r.waitMs('s')).toBe(700);
  });

  it('survives a reload through the store, and drops what is outside every window', () => {
    let t = 0;
    const store = memoryStore();
    const a = new SourceOpenRate({ rules: [{ max: 1, windowMs: 1000 }], now: () => t, store });
    a.take('s');
    t = 400;
    const b = new SourceOpenRate({ rules: [{ max: 1, windowMs: 1000 }], now: () => t, store });
    expect(b.waitMs('s')).toBe(600);
    t = 2000;
    b.take('x');
    expect(JSON.parse(store.data!)).toEqual({ x: [2000] });
  });

  it('a broken store reads as empty and a failing save is ignored', () => {
    const store = { load: () => '{not json', save: () => { throw new Error('quota'); } };
    const r = new SourceOpenRate({ now: () => 0, store });
    expect(r.waitMs('s')).toBe(0);
    expect(() => r.take('s')).not.toThrow();
  });

  it('defaults: 6 opens a minute, 30 in ten minutes', () => {
    expect(DEFAULT_OPEN_RATE).toEqual([{ max: 6, windowMs: 60_000 }, { max: 30, windowMs: 600_000 }]);
  });
});
