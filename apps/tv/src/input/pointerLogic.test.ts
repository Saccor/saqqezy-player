import { describe, expect, it } from 'vitest';
import {
  AUTO_HIDE_MS, CLICK_MAX_MS, CLICK_SLOP_PX, DOUBLE_CLICK_MS, POINTER_BAR_H, POINTER_BTN_W, POINTER_START, ROW_OPTIONS_LABEL, WHEEL_START,
  WHEEL_STEP_MS, barLayout, cellAt, inRect, isClick, isDoubleClick, localPoint, nextClick, pickTarget, pointerModeReducer, rowAt, toDesign,
  wheelPixels, wheelStep, type GridGeometry, type HitCandidate,
} from './pointerLogic.ts';

const moved = (x: number, y: number, at: number) => pointerModeReducer(POINTER_START, { type: 'move', x, y, at });

describe('pointer mode', () => {
  it('starts off; a move turns it on and records where and when', () => {
    expect(POINTER_START.on).toBe(false);
    expect(moved(100, 100, 5)).toEqual({ on: true, lastMoveAt: 5, lastX: 100, lastY: 100 });
  });

  it('any remote key turns it off', () => {
    expect(pointerModeReducer(moved(100, 100, 5), { type: 'key' }).on).toBe(false);
    expect(pointerModeReducer(POINTER_START, { type: 'key' })).toBe(POINTER_START);
  });

  it('ignores moves within 3 px of the last position, on or off (jitter)', () => {
    const on = moved(100, 100, 5);
    expect(pointerModeReducer(on, { type: 'move', x: 102, y: 102, at: 9 })).toBe(on);
    const off = pointerModeReducer(on, { type: 'key' });
    expect(pointerModeReducer(off, { type: 'move', x: 103, y: 100, at: 9 })).toBe(off);
    expect(pointerModeReducer(off, { type: 'move', x: 104, y: 100, at: 9 })).toEqual({ on: true, lastMoveAt: 9, lastX: 104, lastY: 100 });
  });

  it('follows the webOS cursor', () => {
    const shown = pointerModeReducer(POINTER_START, { type: 'cursorShown', at: 7 });
    expect(shown.on).toBe(true);
    expect(shown.lastMoveAt).toBe(7);
    expect(pointerModeReducer(shown, { type: 'cursorHidden' }).on).toBe(false);
  });

  it('a tick turns it off after 3 s without movement, only where the screen opted in (the Player)', () => {
    const s = moved(10, 10, 1000);
    expect(pointerModeReducer(s, { type: 'tick', now: 1000 + AUTO_HIDE_MS - 1, autoHide: true })).toBe(s);
    expect(pointerModeReducer(s, { type: 'tick', now: 1000 + AUTO_HIDE_MS, autoHide: true }).on).toBe(false);
    expect(pointerModeReducer(s, { type: 'tick', now: 1000 + 60_000, autoHide: false })).toBe(s);
  });
});

describe('coordinates', () => {
  it('maps client px to design px at scales 1, 0.5 and 2', () => {
    expect(toDesign(960, 540, { left: 0, top: 0 }, 1)).toEqual({ x: 960, y: 540 });
    expect(toDesign(480, 270, { left: 0, top: 0 }, 0.5)).toEqual({ x: 960, y: 540 });
    expect(toDesign(1920, 1080, { left: 0, top: 0 }, 2)).toEqual({ x: 960, y: 540 });
  });

  it('subtracts the canvas offset first, and treats a zero scale as 1', () => {
    expect(toDesign(110, 70, { left: 10, top: 20 }, 0.5)).toEqual({ x: 200, y: 100 });
    expect(toDesign(50, 60, { left: 0, top: 0 }, 0)).toEqual({ x: 50, y: 60 });
  });

  it('rects include their left and top edge only, and give local points', () => {
    const r = { x: 100, y: 50, w: 200, h: 40 };
    expect(inRect(r, { x: 100, y: 50 })).toBe(true);
    expect(inRect(r, { x: 299.9, y: 89.9 })).toBe(true);
    expect(inRect(r, { x: 300, y: 60 })).toBe(false);
    expect(inRect(r, { x: 150, y: 90 })).toBe(false);
    expect(localPoint(r, { x: 130, y: 65 })).toEqual({ x: 30, y: 15 });
  });
});

describe('rowAt', () => {
  it('maps y to a row at the edges', () => {
    expect(rowAt(0, 0, 84, 10)).toBe(0);
    expect(rowAt(83.9, 0, 84, 10)).toBe(0);
    expect(rowAt(84, 0, 84, 10)).toBe(1);
    expect(rowAt(-1, 0, 84, 10)).toBeUndefined();
    expect(rowAt(84 * 10, 0, 84, 10)).toBeUndefined();
    expect(rowAt(10, 0, 84, 0)).toBeUndefined();
  });

  it('adds the scroll offset', () => {
    expect(rowAt(0, 37, 84, 100)).toBe(37);
    expect(rowAt(84 * 3 + 5, 37, 84, 100)).toBe(40);
    expect(rowAt(84 * 3, 98, 84, 100)).toBeUndefined();
  });
});

describe('cellAt', () => {
  const G: GridGeometry = { rulerH: 44, rowH: 72, viewRows: 8, channelW: 260, timelineX: 288, timelineW: 1440, pxPerHour: 480 };
  const H = 3_600_000;
  const V = 1000 * H;
  const blocks = [{ start: V - H, stop: V + H / 2, title: 'A' }, { start: V + H / 2, stop: V + 2 * H, title: 'B' }];
  const of = () => blocks;

  it('the ruler and the space below the rows are not cells', () => {
    expect(cellAt(400, 10, G, 0, 20, V, of)).toBeUndefined();
    expect(cellAt(400, 44 + 8 * 72, G, 0, 20, V, of)).toBeUndefined();
  });

  it('the channel column gives the row, with the scroll offset', () => {
    expect(cellAt(10, 44, G, 0, 20, V, of)).toEqual({ area: 'channels', row: 0 });
    expect(cellAt(259, 44 + 72 * 2 + 5, G, 5, 20, V, of)).toEqual({ area: 'channels', row: 7 });
  });

  it('the timeline gives the block under that time (start inclusive)', () => {
    expect(cellAt(288, 50, G, 0, 20, V, of)).toEqual({ area: 'grid', row: 0, block: blocks[0] });
    expect(cellAt(288 + 239, 50, G, 0, 20, V, of)).toEqual({ area: 'grid', row: 0, block: blocks[0] });
    expect(cellAt(288 + 240, 50, G, 0, 20, V, of)).toEqual({ area: 'grid', row: 0, block: blocks[1] });
  });

  it('nothing between the columns, past the timeline, after the last block or below the last row', () => {
    expect(cellAt(270, 50, G, 0, 20, V, of)).toBeUndefined();
    expect(cellAt(288 + 1440, 50, G, 0, 20, V, of)).toBeUndefined();
    expect(cellAt(288 + 1000, 50, G, 0, 20, V, of)).toBeUndefined();
    expect(cellAt(10, 44 + 72 * 3, G, 0, 3, V, of)).toBeUndefined();
  });
});

describe('clicks', () => {
  const down = { x: 100, y: 100, at: 0 };

  it('a click is a release within 8 px and 500 ms; anything else is a drag or a long press', () => {
    expect(isClick(down, { x: 100, y: 100, at: 0 })).toBe(true);
    expect(isClick(down, { x: 100 + CLICK_SLOP_PX, y: 100, at: CLICK_MAX_MS })).toBe(true);
    expect(isClick(down, { x: 109, y: 100, at: 10 })).toBe(false);
    expect(isClick(down, { x: 100, y: 100, at: CLICK_MAX_MS + 1 })).toBe(false);
  });

  it('a double click is a second click on the same target within 350 ms', () => {
    expect(isDoubleClick(undefined, 100, 1)).toBe(false);
    expect(isDoubleClick({ at: 0, target: 1 }, DOUBLE_CLICK_MS, 1)).toBe(true);
    expect(isDoubleClick({ at: 0, target: 1 }, DOUBLE_CLICK_MS + 1, 1)).toBe(false);
    expect(isDoubleClick({ at: 0, target: 1 }, 100, 2)).toBe(false);
  });

  it('on a list, the second click must be on the same row (sub)', () => {
    expect(isDoubleClick({ at: 0, target: 1, sub: 3 }, 100, 1, 3)).toBe(true);
    expect(isDoubleClick({ at: 0, target: 1, sub: 3 }, 100, 1, 4)).toBe(false);
    expect(isDoubleClick({ at: 0, target: 1, sub: 3 }, 100, 1)).toBe(false);
    expect(isDoubleClick({ at: 0, target: 1 }, 100, 1, 3)).toBe(false);
  });

  it('nextClick: a double click resets the last click, any other click becomes the new last click', () => {
    const first = nextClick(undefined, 0, 1, 3);
    expect(first).toEqual({ double: false, last: { at: 0, target: 1, sub: 3 } });
    expect(nextClick(first.last, 100, 1, 3)).toEqual({ double: true, last: undefined });
    // Another row of the same list: a fresh first click there.
    expect(nextClick(first.last, 100, 1, 4)).toEqual({ double: false, last: { at: 100, target: 1, sub: 4 } });
    // A third click after a double click starts over.
    expect(nextClick(undefined, 200, 1, 3).double).toBe(false);
    expect(nextClick({ at: 0, target: 1 }, 100, 1)).toEqual({ double: true, last: undefined });
  });
});

describe('wheel', () => {
  it('normalises line and page deltas to px', () => {
    expect(wheelPixels(100, 0)).toBe(100);
    expect(wheelPixels(3, 1)).toBe(120);
    expect(wheelPixels(1, 2)).toBe(800);
  });

  it('one mouse notch is one step, in its direction', () => {
    expect(wheelStep(WHEEL_START, 100, 0, 1000)).toMatchObject({ dy: 1, dx: 0 });
    expect(wheelStep(WHEEL_START, -100, 0, 1000)).toMatchObject({ dy: -1, dx: 0 });
  });

  it('steps at most once every 120 ms', () => {
    let r = wheelStep(WHEEL_START, 100, 0, 1000);
    r = wheelStep(r.state, 100, 0, 1050);
    expect(r.dy).toBe(0);
    r = wheelStep(r.state, 10, 0, 1000 + WHEEL_STEP_MS);
    expect(r.dy).toBe(1);
  });

  it('accumulates small deltas (trackpads)', () => {
    let r = wheelStep(WHEEL_START, 20, 0, 1000);
    expect(r.dy).toBe(0);
    r = wheelStep(r.state, 20, 0, 1010);
    expect(r.dy).toBe(0);
    r = wheelStep(r.state, 20, 0, 1020);
    expect(r.dy).toBe(1);
  });

  it('a change of direction starts over', () => {
    let r = wheelStep(WHEEL_START, 40, 0, 1000);
    r = wheelStep(r.state, -40, 0, 1010);
    expect(r.dy).toBe(0);
    r = wheelStep(r.state, -20, 0, 1020);
    expect(r.dy).toBe(-1);
  });

  it('ignores non-finite deltas', () => {
    const r = wheelStep(WHEEL_START, Number.NaN, Number.POSITIVE_INFINITY, 1000);
    expect(r).toEqual({ state: WHEEL_START, dy: 0, dx: 0 });
    expect(wheelStep(r.state, 100, 0, 1000).dy).toBe(1);
  });

  it('throttles the two axes separately', () => {
    let r = wheelStep(WHEEL_START, 100, 0, 1000);
    r = wheelStep(r.state, 0, 100, 1010);
    expect([r.dy, r.dx]).toEqual([0, 1]);
  });
});

describe('barLayout', () => {
  it('places buttons one after another with a gap', () => {
    expect(barLayout([200, 160, 200], 12)).toEqual({ offsets: [0, 212, 384], total: 584 });
    expect(barLayout([], 12)).toEqual({ offsets: [], total: 0 });
  });

  it('uses the spec sizes and symbol', () => {
    expect([POINTER_BAR_H, POINTER_BTN_W, ROW_OPTIONS_LABEL]).toEqual([56, 200, '⋯']);
  });
});

describe('pickTarget', () => {
  const P = { x: 5, y: 5 };
  const cand = (over: Partial<HitCandidate>): HitCandidate => ({
    rect: { x: 0, y: 0, w: 100, h: 100 }, overlay: false, seq: 1, enabled: true, visible: true, inScope: true, ...over,
  });

  it('only targets under the point', () => {
    expect(pickTarget([cand({ rect: { x: 200, y: 0, w: 10, h: 10 } })], P)).toBeUndefined();
    expect(pickTarget([cand({})], { x: 0, y: 0 })).toBe(0);
    expect(pickTarget([cand({})], { x: 100, y: 50 })).toBeUndefined();
  });

  it('the latest screen target wins', () => {
    expect(pickTarget([cand({ seq: 1 }), cand({ seq: 5 }), cand({ seq: 3 })], P)).toBe(1);
  });

  it('an overlay beats the screen even when it is older; the latest overlay wins', () => {
    expect(pickTarget([cand({ seq: 1, overlay: true }), cand({ seq: 9 })], P)).toBe(0);
    expect(pickTarget([cand({ seq: 2, overlay: true }), cand({ seq: 4, overlay: true }), cand({ seq: 9 })], P)).toBe(1);
  });

  it("skips disabled and invisible targets, and other screens' targets", () => {
    expect(pickTarget([cand({ seq: 1 }), cand({ seq: 2, overlay: true, enabled: false })], P)).toBe(0);
    expect(pickTarget([cand({ seq: 1 }), cand({ seq: 2, visible: false })], P)).toBe(0);
    expect(pickTarget([cand({ seq: 1 }), cand({ seq: 2, overlay: true, inScope: false })], P)).toBe(0);
    expect(pickTarget([cand({ visible: false })], P)).toBeUndefined();
  });

  it('a shown overlay is modal: screen targets underneath, global ones included, are never hit', () => {
    const screen = cand({ seq: 9, rect: { x: 0, y: 0, w: 1920, h: 1080 } });
    const dialog = cand({ seq: 1, overlay: true, rect: { x: 500, y: 300, w: 100, h: 100 } });
    expect(pickTarget([screen, dialog], P)).toBeUndefined();
    expect(pickTarget([screen, dialog], { x: 550, y: 350 })).toBe(1);
    // A global target (the shell Back) is a screen target that is always in scope.
    const globalBack = cand({ seq: 10, rect: { x: 0, y: 0, w: 200, h: 72 } });
    expect(pickTarget([globalBack, dialog], P)).toBeUndefined();
  });

  it('a disabled, invisible or out-of-scope overlay blocks nothing', () => {
    const screen = cand({ seq: 9 });
    const far = { x: 500, y: 300, w: 100, h: 100 };
    expect(pickTarget([screen, cand({ seq: 1, overlay: true, rect: far, enabled: false })], P)).toBe(0);
    expect(pickTarget([screen, cand({ seq: 1, overlay: true, rect: far, visible: false })], P)).toBe(0);
    expect(pickTarget([screen, cand({ seq: 1, overlay: true, rect: far, inScope: false })], P)).toBe(0);
  });

  it("a click outside an overlay's targets resolves to its backdrop", () => {
    const screen = cand({ seq: 1 });
    const backdrop = cand({ seq: 2, overlay: true, rect: { x: 0, y: 0, w: 1920, h: 1080 } });
    const button = cand({ seq: 3, overlay: true, rect: { x: 500, y: 300, w: 100, h: 100 } });
    expect(pickTarget([screen, backdrop, button], P)).toBe(1);
    expect(pickTarget([screen, backdrop, button], { x: 550, y: 350 })).toBe(2);
  });

  it('a global screen-layer target (the shell Back) does not block other screen targets', () => {
    const back = cand({ seq: 9, rect: { x: 0, y: 0, w: 20, h: 20 } }); // global is resolved into inScope by the caller
    const other = cand({ seq: 2, rect: { x: 200, y: 200, w: 50, h: 50 } });
    expect(pickTarget([other, back], { x: 210, y: 210 })).toBe(0);
    expect(pickTarget([other, back], { x: 5, y: 5 })).toBe(1);
  });
});
