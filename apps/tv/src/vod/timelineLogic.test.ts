import { describe, expect, it } from 'vitest';
import { bubbleX, bufferedEndMs, elapsedText, fractionAt, remainingText } from './timelineLogic.ts';

describe('fractionAt', () => {
  it('maps x across the width and clamps', () => {
    expect(fractionAt(432, 1728)).toBe(0.25);
    expect(fractionAt(-40, 1728)).toBe(0);
    expect(fractionAt(2000, 1728)).toBe(1);
    expect(fractionAt(10, 0)).toBe(0);
  });
});

describe('bufferedEndMs', () => {
  it('is the playhead plus what is buffered, never past the end', () => {
    expect(bufferedEndMs(60_000, 12_500, 600_000)).toBe(72_500);
    expect(bufferedEndMs(595_000, 20_000, 600_000)).toBe(600_000);
  });
  it('is unknown without a buffer reading', () => {
    expect(bufferedEndMs(60_000, undefined, 600_000)).toBeUndefined();
    expect(bufferedEndMs(60_000, 0, 600_000)).toBeUndefined();
    expect(bufferedEndMs(60_000, Number.NaN, 600_000)).toBeUndefined();
  });
});

describe('elapsedText', () => {
  it('shows elapsed / total, or elapsed alone without a duration', () => {
    expect(elapsedText(754_000, 6_300_000)).toBe('12:34 / 1:45:00');
    expect(elapsedText(754_000, undefined)).toBe('12:34');
  });
});

describe('remainingText', () => {
  it('shows the time left and the local end time', () => {
    const now = new Date(2026, 9, 17, 20, 15, 0).getTime();
    expect(remainingText(754_000, 6_300_000, now)).toBe('−1:32:26 · ends 21:47');
  });
  it('pads hours and minutes and wraps past midnight', () => {
    const now = new Date(2026, 9, 17, 23, 58, 0).getTime();
    expect(remainingText(0, 600_000, now)).toBe('−10:00 · ends 00:08');
  });
});

describe('bubbleX', () => {
  it('centres the bubble on x and keeps it inside the range', () => {
    expect(bubbleX(500, 200, 96, 1824)).toBe(400);
    expect(bubbleX(120, 200, 96, 1824)).toBe(96);
    expect(bubbleX(1800, 200, 96, 1824)).toBe(1624);
  });
});
