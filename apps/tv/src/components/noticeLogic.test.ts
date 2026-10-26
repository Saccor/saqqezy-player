// apps/tv/src/components/noticeLogic.test.ts
import { describe, expect, it } from 'vitest';
import { LAYOUT, MOTION, TYPE } from '../shell/theme.ts';
import {
  NOTICE_GAP, NOTICE_H, NOTICE_MAX_SHOWN, NOTICE_MAX_W, NOTICE_MIN_W, NOTICE_NUMERAL_H, NOTICE_PAD, NOTICE_SPINNER, NOTICE_TOP,
  autoHideDelay, noticeAutoHides, noticeIds, noticeOrder, noticeStack, sameIds, spinnerDots, type NoticeSpec,
} from './noticeLogic.ts';

/** 10 px a character, whatever the size: easy numbers. */
const measure = (t: string) => t.length * 10;
const n = (id: string, kind: NoticeSpec['kind'], text = 'Synthetic notice', extra: Partial<NoticeSpec> = {}): NoticeSpec => ({ id, kind, text, ...extra });

describe('notice order and kinds (spec 2026-10-26 §1.3)', () => {
  it('errors first, then waits, then infos; stable inside a kind', () => {
    const order = noticeOrder([n('a', 'info'), n('b', 'wait'), n('c', 'error'), n('d', 'info'), n('e', 'error')]).map((x) => x.id);
    expect(order).toEqual(['c', 'e', 'b', 'a', 'd']);
  });
  it('only info hides by itself', () => {
    expect(noticeAutoHides('info')).toBe(true);
    expect(noticeAutoHides('wait')).toBe(false);
    expect(noticeAutoHides('error')).toBe(false);
  });
});

describe('noticeStack: one pill each, top right under the clock', () => {
  it('the text box is never narrower than the measured text (a fraction rounded away wrapped it to "Added to...")', () => {
    // Canvas width of "Added to favourites" at 28 px sans-serif in desktop Chrome.
    const [p] = noticeStack([n('a', 'info', 'Added to favourites')], () => 241.267578125);
    expect(p!.textW).toBeGreaterThanOrEqual(241.267578125);
    expect(Number.isInteger(p!.w)).toBe(true);
    const [q] = noticeStack([n('a', 'error', 'Synthetic error', { action: 'Try again' })], (t) => (t === 'Try again' ? 100.4 : 150.6));
    expect(q!.textW).toBeGreaterThanOrEqual(150.6);
    expect(q!.w - NOTICE_PAD - q!.actionX!).toBeGreaterThanOrEqual(100.4);
  });
  it('right-aligns to the safe edge and sizes to the text', () => {
    const [p] = noticeStack([n('a', 'info', 'Saved')], measure);
    expect(p!.y).toBe(NOTICE_TOP);
    expect(p!.h).toBe(NOTICE_H);
    expect(p!.w).toBe(NOTICE_MIN_W); // 24 + 50 + 24 < 240
    expect(p!.x + p!.w).toBe(LAYOUT.width - LAYOUT.safeX);
    expect(p!.textX).toBe(NOTICE_PAD);
  });
  it('a long text is capped at the max width', () => {
    const [p] = noticeStack([n('a', 'info', 'x'.repeat(200))], measure);
    expect(p!.w).toBe(NOTICE_MAX_W);
    expect(p!.textW).toBe(NOTICE_MAX_W - NOTICE_PAD * 2);
  });
  it('a spinner leads the text; an action label ends the pill', () => {
    const [p] = noticeStack([n('a', 'wait', 'Loading…', { spinner: true })], measure);
    expect(p!.textX).toBe(NOTICE_PAD + NOTICE_SPINNER + 16);
    const [q] = noticeStack([n('b', 'error', 'x'.repeat(40), { action: 'Try again' })], measure);
    expect(q!.actionX).toBe(q!.w - NOTICE_PAD - 90);
    expect(q!.textX + q!.textW).toBe(q!.actionX! - 24);
  });
  it('a numeral notice is taller and stacks below; at most three show', () => {
    const placed = noticeStack([n('a', 'info'), n('b', 'wait', '123', { numeral: true }), n('c', 'info'), n('d', 'info')], measure);
    expect(placed).toHaveLength(NOTICE_MAX_SHOWN);
    expect(placed[0]!.spec.id).toBe('b');
    expect(placed[0]!.h).toBe(NOTICE_NUMERAL_H);
    expect(placed[1]!.y).toBe(NOTICE_TOP + NOTICE_NUMERAL_H + NOTICE_GAP);
    expect(NOTICE_NUMERAL_H).toBe(TYPE.numeral + 48);
  });
});

describe('autoHideDelay (MOTION.autoHide: pauses while keys are pressed, never while held open)', () => {
  it('hides autoHide after it showed when no key came', () => {
    expect(autoHideDelay({ shownAt: 0, lastKeyAt: -1, now: 1000, held: false })).toBe(MOTION.autoHide - 1000);
    expect(autoHideDelay({ shownAt: 0, lastKeyAt: -1, now: MOTION.autoHide, held: false })).toBe(0);
  });
  it('a key press restarts the window', () => {
    expect(autoHideDelay({ shownAt: 0, lastKeyAt: 3000, now: 4000, held: false })).toBe(MOTION.autoHide - 1000);
  });
  it('while a sheet is open (held) it waits a full window again', () => {
    expect(autoHideDelay({ shownAt: 0, lastKeyAt: -1, now: 9000, held: true })).toBe(MOTION.autoHide);
  });
});

describe('spinner', () => {
  it('eight dots on a circle inside the spinner box', () => {
    const dots = spinnerDots();
    expect(dots).toHaveLength(8);
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(NOTICE_SPINNER);
      expect(d.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('noticeIds / sameIds (pills are keyed by id so a staying pill keeps its node)', () => {
  const stack = (ids: string[]) => noticeStack(ids.map((id) => n(id, 'info')), measure);
  it('lists the placed ids in stack order', () => {
    expect(noticeIds(stack(['a', 'b']))).toEqual(['a', 'b']);
  });
  it('sameIds is true for equal lists even when the arrays are new, false when an id comes, goes or moves', () => {
    expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});

