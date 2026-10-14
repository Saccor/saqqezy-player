import { describe, expect, it } from 'vitest';
import {
  HALF_HOUR, HOUR, NO_INFO, dayLabel, relativeLabel, PX_PER_HOUR, VIEW_SPAN, blockIndexAt, buildBlocks, chunkStarts, clampViewStart,
  floorHalfHour, guideOpenTarget, guideWindow, initialViewStart, isOnAir, pageRange, prefetchRange, stepLeft, stepRight, ticks,
  timeToX, xToTime, type Block,
} from './guideLogic.ts';

const T0 = Date.UTC(2026, 0, 10, 12, 0); // a half-hour boundary
const at = (h: number) => T0 + h * HOUR;
const prog = (fromH: number, toH: number, title = `P${fromH}`) => ({ title, start: at(fromH), stop: at(toH) });
/** 30-minute "Programme N" slots between two hours. */
const slots = (fromH: number, toH: number) => {
  const out = [];
  for (let h = fromH; h < toH; h += 0.5) out.push(prog(h, h + 0.5, `Programme ${h}`));
  return out;
};
const win = { start: at(-6), end: at(48) };

describe('time <-> x', () => {
  it('maps one hour to 480 px from the view start, and back', () => {
    expect(PX_PER_HOUR).toBe(480);
    expect(timeToX(at(0), at(0))).toBe(0);
    expect(timeToX(at(1.5), at(0))).toBe(720);
    expect(timeToX(at(-0.5), at(0))).toBe(-240);
    expect(xToTime(240, at(0))).toBe(at(0.5));
    expect(xToTime(timeToX(at(2.25), at(1)), at(1))).toBe(at(2.25));
  });

  it('floors to the half hour and builds the -6 h..+48 h window from it', () => {
    expect(floorHalfHour(T0 + 17 * 60_000)).toBe(T0);
    expect(floorHalfHour(T0 + 31 * 60_000)).toBe(T0 + HALF_HOUR);
    expect(floorHalfHour(T0)).toBe(T0);
    expect(guideWindow(T0 + 10 * 60_000)).toEqual({ start: at(-6), end: at(48) });
  });

  it('starts the view at the half hour before now, clamped to the window', () => {
    expect(initialViewStart(T0 + 40 * 60_000, win)).toBe(at(0.5));
    expect(clampViewStart(at(-9), win)).toBe(at(-6));
    expect(clampViewStart(at(47), win)).toBe(at(48) - VIEW_SPAN);
  });

  it('lists the 30-minute tick marks of the view', () => {
    expect(ticks(at(0))).toEqual([0, 0.5, 1, 1.5, 2, 2.5].map(at));
  });
});

describe('buildBlocks', () => {
  it('keeps programmes inside the loaded range in order, dropping duplicates and empty ones', () => {
    const blocks = buildBlocks([prog(1, 1.5), prog(0, 0.5), prog(0.5, 1), prog(0, 0.5), prog(2, 2)], [{ start: at(0), end: at(1.5) }]);
    expect(blocks.map((b) => [b.start, b.stop, b.filler])).toEqual([
      [at(0), at(0.5), false], [at(0.5), at(1), false], [at(1), at(1.5), false],
    ]);
  });

  it('fills a channel without EPG with one "No information" block over the loaded range', () => {
    const blocks = buildBlocks([], [{ start: at(3), end: at(6) }, { start: at(0), end: at(3) }]);
    expect(blocks).toEqual([{ start: at(0), stop: at(6), title: NO_INFO, filler: true }]);
  });

  it('fills gaps between and around programmes, and nothing outside the loaded range', () => {
    const blocks = buildBlocks([prog(1, 2, 'A'), prog(2.5, 3, 'B')], [{ start: at(0), end: at(3) }, { start: at(6), end: at(9) }]);
    expect(blocks.map((b) => [(b.start - T0) / HOUR, (b.stop - T0) / HOUR, b.title])).toEqual([
      [0, 1, NO_INFO], [1, 2, 'A'], [2, 2.5, NO_INFO], [2.5, 3, 'B'], [6, 9, NO_INFO],
    ]);
  });

  it('keeps a programme that crosses the edge of the loaded range whole, once', () => {
    const blocks = buildBlocks([prog(2.5, 3.5, 'X')], [{ start: at(0), end: at(3) }, { start: at(3), end: at(6) }]);
    expect(blocks.map((b) => [(b.start - T0) / HOUR, (b.stop - T0) / HOUR, b.title])).toEqual([
      [0, 2.5, NO_INFO], [2.5, 3.5, 'X'], [3.5, 6, NO_INFO],
    ]);
  });

  it('clips an overlapping programme to start where the previous one stops', () => {
    const blocks = buildBlocks([prog(0, 1, 'A'), prog(0.5, 1.5, 'B')], [{ start: at(0), end: at(1.5) }]);
    expect(blocks.map((b) => [(b.start - T0) / HOUR, (b.stop - T0) / HOUR, b.title])).toEqual([[0, 1, 'A'], [1, 1.5, 'B']]);
  });
});

describe('picking the programme at a time', () => {
  const blocks = buildBlocks(slots(0, 3), [{ start: at(0), end: at(3) }]);
  it('finds the block containing the time (start inclusive, stop exclusive)', () => {
    expect(blockIndexAt(blocks, at(0))).toBe(0);
    expect(blockIndexAt(blocks, at(0.49))).toBe(0);
    expect(blockIndexAt(blocks, at(0.5))).toBe(1);
    expect(blockIndexAt(blocks, at(2.9))).toBe(5);
  });
  it('falls back to the nearest block, or -1 when the row is empty', () => {
    expect(blockIndexAt(blocks, at(-2))).toBe(0);
    expect(blockIndexAt(blocks, at(7))).toBe(5);
    expect(blockIndexAt([], at(1))).toBe(-1);
  });
  it('tells whether a block is on air', () => {
    expect(isOnAir(blocks[1]!, at(0.5))).toBe(true);
    expect(isOnAir(blocks[1]!, at(1))).toBe(false);
  });
});

describe('Left / Right', () => {
  const blocks = buildBlocks(slots(-6, 12), [{ start: at(-6), end: at(12) }]);
  const idx = (h: number) => blockIndexAt(blocks, at(h));

  it('moves to the next programme without scrolling while it is well inside the view', () => {
    expect(stepRight(blocks, idx(0), { viewStart: at(0), anchor: at(0) }, win))
      .toEqual({ kind: 'move', index: idx(0.5), viewStart: at(0), anchor: at(0.5) });
  });

  it('scrolls time when the next programme starts in the last half hour of the view', () => {
    expect(stepRight(blocks, idx(2), { viewStart: at(0), anchor: at(2) }, win))
      .toEqual({ kind: 'move', index: idx(2.5), viewStart: at(1.5), anchor: at(2.5) });
  });

  it('moves back to the previous programme, scrolling back when it starts before the view', () => {
    expect(stepLeft(blocks, idx(1), { viewStart: at(0), anchor: at(1) }, win))
      .toEqual({ kind: 'move', index: idx(0.5), viewStart: at(0), anchor: at(0.5) });
    expect(stepLeft(blocks, idx(0), { viewStart: at(0), anchor: at(0) }, win))
      .toEqual({ kind: 'move', index: idx(-0.5), viewStart: at(-0.5), anchor: at(-0.5) });
  });

  it('reports the left edge at the first programme of the window', () => {
    expect(stepLeft(blocks, idx(-6), { viewStart: at(-6), anchor: at(-6) }, win)).toEqual({ kind: 'edge' });
  });

  it('scrolls through a long block an hour at a time instead of jumping past it', () => {
    const long = buildBlocks([], [{ start: at(-6), end: at(48) }]);
    expect(stepRight(long, 0, { viewStart: at(0), anchor: at(0) }, win))
      .toEqual({ kind: 'scroll', viewStart: at(1), anchor: at(1) });
    expect(stepLeft(long, 0, { viewStart: at(0), anchor: at(1) }, win))
      .toEqual({ kind: 'scroll', viewStart: at(-1), anchor: at(-1) });
    expect(stepLeft(long, 0, { viewStart: at(-6), anchor: at(-6) }, win)).toEqual({ kind: 'edge' });
    expect(stepRight(long, 0, { viewStart: at(45), anchor: at(45) }, win)).toEqual({ kind: 'none' });
  });

  it('scrolls an hour on a row that has not loaded yet', () => {
    expect(stepRight([], -1, { viewStart: at(0), anchor: at(0.2) }, win))
      .toEqual({ kind: 'scroll', viewStart: at(1), anchor: at(1) });
    expect(stepLeft([], -1, { viewStart: at(0), anchor: at(0.2) }, win))
      .toEqual({ kind: 'scroll', viewStart: at(-1), anchor: at(0.2) });
    expect(stepLeft([], -1, { viewStart: at(-6), anchor: at(-6) }, win)).toEqual({ kind: 'edge' });
  });

  it('scrolls back, not to the channel column, at the first loaded block before the window start', () => {
    const loaded = buildBlocks(slots(-3, 3), [{ start: at(-3), end: at(3) }]);
    const s = stepLeft(loaded, 0, { viewStart: at(-3), anchor: at(-3) }, win);
    expect(s).toEqual({ kind: 'scroll', viewStart: at(-4), anchor: at(-3) });
    // Once the view reaches the window start (or the block starts there) it is a real edge.
    expect(stepLeft(loaded, 0, { viewStart: at(-6), anchor: at(-3) }, win)).toEqual({ kind: 'edge' });
  });

  it('scrolls forward, not into a dead end, at the last loaded block before the window end', () => {
    const loaded = buildBlocks(slots(0, 3), [{ start: at(0), end: at(3) }]);
    const last = loaded.length - 1;
    const s = stepRight(loaded, last, { viewStart: at(0), anchor: at(2.5) }, win);
    expect(s).toEqual({ kind: 'scroll', viewStart: at(1), anchor: at(2.5) });
  });

  it('never moves past the end of the window', () => {
    const tail: Block[] = buildBlocks(slots(46, 48), [{ start: at(45), end: at(48) }]);
    const last = tail.length - 1;
    expect(stepRight(tail, last, { viewStart: at(45), anchor: at(47.5) }, win)).toEqual({ kind: 'none' });
  });
});

describe('Up / Down keep the time position', () => {
  it('picks the programme at the anchor in the new row', () => {
    const halfHours = buildBlocks(slots(0, 3), [{ start: at(0), end: at(3) }]);
    const hours = buildBlocks([prog(0, 1), prog(1, 2), prog(2, 3)], [{ start: at(0), end: at(3) }]);
    expect(blockIndexAt(hours, at(1.5))).toBe(1);
    expect(blockIndexAt(halfHours, at(1.5))).toBe(3);
    // Moving back keeps the same anchor, so it lands on the same half hour again.
    expect(halfHours[blockIndexAt(halfHours, at(1.5))]!.start).toBe(at(1.5));
  });
});

describe('paging and prefetch', () => {
  it('prefetches 3 h either side of the visible 3 h, inside the window', () => {
    expect(prefetchRange(at(0), win)).toEqual({ start: at(-3), end: at(6) });
    expect(prefetchRange(at(-6), win)).toEqual({ start: at(-6), end: at(0) });
    expect(prefetchRange(at(45), win)).toEqual({ start: at(42), end: at(48) });
  });

  it('splits a time range into aligned chunks', () => {
    const chunk = 3 * HOUR;
    const base = Math.floor(at(0) / chunk) * chunk;
    expect(chunkStarts({ start: base + HOUR, end: base + 7 * HOUR }, chunk)).toEqual([base, base + chunk, base + 2 * chunk]);
    expect(chunkStarts({ start: base, end: base + chunk }, chunk)).toEqual([base]);
    expect(chunkStarts({ start: base, end: base }, chunk)).toEqual([]);
  });

  it('lists the pages of 20 rows touching a row range', () => {
    expect(pageRange(0, 12, 20)).toEqual([0]);
    expect(pageRange(15, 27, 20)).toEqual([0, 1]);
    expect(pageRange(40, 41, 20)).toEqual([2]);
    expect(pageRange(5, 5, 20)).toEqual([]);
  });
});

describe('labels', () => {
  const local = (d: number, h: number, m = 0) => new Date(2026, 0, d, h, m).getTime();
  it('names the day relative to now in local time', () => {
    expect(dayLabel(local(10, 23, 30), local(10, 8))).toBe('Today');
    expect(dayLabel(local(11, 0, 30), local(10, 8))).toBe('Tomorrow');
    expect(dayLabel(local(9, 22), local(10, 8))).toBe('Yesterday');
    expect(dayLabel(local(13, 9), local(10, 8))).toBe('Tue 13 Jan');
  });
  it('says whether a programme is on now, upcoming or over', () => {
    const b = { start: local(10, 14), stop: local(10, 14, 30) };
    expect(relativeLabel(b, local(10, 14, 10))).toBe('On now');
    expect(relativeLabel(b, local(10, 13, 15))).toBe('Starts in 45 min');
    expect(relativeLabel(b, local(10, 11, 55))).toBe('Starts in 2 h 5 min');
    expect(relativeLabel(b, local(10, 12))).toBe('Starts in 2 h');
    expect(relativeLabel(b, local(10, 14, 30))).toBe('Ended');
  });
});

describe('guideOpenTarget', () => {
  const now = Date.UTC(2026, 9, 13, 18, 10);
  const gw = guideWindow(now);

  it('no params: current behaviour', () => {
    expect(guideOpenTarget({}, now, gw)).toEqual({ viewStart: initialViewStart(now, gw), anchor: now });
    expect(guideOpenTarget({ groupId: 'g:News' }, now, gw)).toEqual({ groupId: 'g:News', viewStart: initialViewStart(now, gw), anchor: now });
  });

  it('channel and time: All channels, view at the half hour of `at`', () => {
    const when = now + 3 * HOUR + 20 * 60_000;
    expect(guideOpenTarget({ channelId: 's:7', at: when }, now, gw)).toEqual({
      channelId: 's:7', groupId: 'all', viewStart: Math.floor(when / HALF_HOUR) * HALF_HOUR, anchor: when,
    });
  });

  it('an explicit group wins; `at` beyond the window is clamped', () => {
    const t = guideOpenTarget({ channelId: 's:7', groupId: 'g:Kids', at: now + 100 * HOUR }, now, gw);
    expect(t.groupId).toBe('g:Kids');
    expect(t.anchor).toBe(gw.end - 1);
    expect(t.viewStart).toBe(gw.end - 3 * HOUR);
  });

  it('ignores a non-numeric `at` and a non-string channel', () => {
    expect(guideOpenTarget({ channelId: 7, at: 'soon' }, now, gw)).toEqual({ viewStart: initialViewStart(now, gw), anchor: now });
  });
});
