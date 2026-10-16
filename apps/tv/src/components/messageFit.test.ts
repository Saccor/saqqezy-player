import { describe, expect, it } from 'vitest';
import { failureText } from '../playback/failureText.ts';
import { MESSAGE_BOXES, fitsBox, messageLines, messageTop } from './messageFit.ts';

/** The longest failure text: a refusal naming the account's limit. */
const LONG = failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 }, 'video');

describe('messageLines', () => {
  it('estimates wrapped lines from the box width, capped at its maximum', () => {
    const box = { charsPerLine: 10, maxLines: 3, lineH: 30 };
    expect(messageLines('', box)).toBe(1);
    expect(messageLines('x'.repeat(10), box)).toBe(1);
    expect(messageLines('x'.repeat(11), box)).toBe(2);
    expect(messageLines('x'.repeat(100), box)).toBe(3);
    expect(fitsBox('x'.repeat(30), box)).toBe(true);
    expect(fitsBox('x'.repeat(31), box)).toBe(false);
  });

  it('centres the lines in the box', () => {
    const box = { charsPerLine: 10, maxLines: 3, lineH: 30 };
    expect(messageTop('x', box, 100)).toBe(35);
    expect(messageTop('x'.repeat(25), box, 100)).toBe(5);
  });
});

describe('MESSAGE_BOXES', () => {
  it('the longest failure text fits every box that shows failures', () => {
    for (const key of ['preview', 'guide', 'player', 'vodCardSmall'] as const) {
      expect(fitsBox(LONG, MESSAGE_BOXES[key]), key).toBe(true);
    }
  });

  it('every box keeps its lines inside its height', () => {
    const heights = { preview: 331, guide: 270, player: 206, vodCard: 124, vodCardSmall: 124 } as const;
    for (const [key, h] of Object.entries(heights)) {
      const b = MESSAGE_BOXES[key as keyof typeof MESSAGE_BOXES];
      expect(b.maxLines * b.lineH, key).toBeLessThanOrEqual(h);
    }
  });
});
