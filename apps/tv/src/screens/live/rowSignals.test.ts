import { describe, expect, it } from 'vitest';
import { createRowSignals, type NumberSignal } from './rowSignals.ts';

/** Fake signals: each records its reads and writes, so the test sees exactly what a row's memo would depend on. */
function fakes() {
  const made: Array<{ reads: number; writes: number[] }> = [];
  const make = (initial: number): NumberSignal => {
    const s = { value: initial, reads: 0, writes: [] as number[] };
    made.push(s);
    return [() => { s.reads += 1; return s.value; }, (v) => { s.writes.push(v); s.value = v; }];
  };
  return { made, make };
}

describe('createRowSignals', () => {
  it('a row tracks the all-rows signal and its own page signal', () => {
    const f = fakes();
    const rs = createRowSignals(20, f.make);
    rs.track(25); // page 1
    expect(f.made).toHaveLength(2); // all + page 1
    expect(f.made.map((s) => s.reads)).toEqual([1, 1]);
  });

  it('a landing page bumps only that page: rows of other pages do not re-run', () => {
    const f = fakes();
    const rs = createRowSignals(20, f.make);
    rs.track(5);  // page 0 -> made[1]
    rs.track(25); // page 1 -> made[2]
    rs.apply({ all: false, pages: [1], totalChanged: false });
    expect(f.made[0]!.writes).toEqual([]); // all
    expect(f.made[1]!.writes).toEqual([]); // page 0
    expect(f.made[2]!.writes).toEqual([1]); // page 1
  });

  it('a new total or an invalidate bumps the all-rows signal; untracked pages create nothing', () => {
    const f = fakes();
    const rs = createRowSignals(20, f.make);
    rs.trackAll();
    rs.apply({ all: false, pages: [7], totalChanged: true });
    rs.apply({ all: true });
    expect(f.made).toHaveLength(1);
    expect(f.made[0]!.writes).toEqual([1, 2]);
  });

  it('apply never reads a signal (safe to call inside an effect without subscribing it)', () => {
    const f = fakes();
    const rs = createRowSignals(20, f.make);
    rs.track(0);
    const readsBefore = f.made.map((s) => s.reads);
    rs.apply({ all: false, pages: [0], totalChanged: true });
    expect(f.made.map((s) => s.reads)).toEqual(readsBefore);
  });
});
