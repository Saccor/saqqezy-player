import { describe, expect, it } from 'vitest';
import { failureText } from '../playback/failureText.ts';
import { COOLDOWN_TEXT } from '../state/cooldownLogic.ts';
import { LINE } from '../shell/theme.ts';
import { MESSAGE_BOXES, fitsBox, messageLines, messageTop } from './messageFit.ts';

/** The longest failure text: a refusal naming the account's limit. */
const LONG = failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 });

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
  /** Every text a failure box shows for a stream or a video. */
  const failures = () => [
    failureText({ reason: 'unavailable' }),
    failureText({ reason: 'unavailable', httpStatus: 404 }),
    failureText({ reason: 'unsupported' }),
    failureText({ reason: 'gone', httpStatus: 404 }),
    failureText({ reason: 'refused', httpStatus: 429 }),
    failureText({ reason: 'refused', httpStatus: 403 }),
    failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 }),
  ];

  it('the longest failure text fits every box that shows failures', () => {
    for (const key of ['preview', 'guide', 'player', 'vodCard'] as const) {
      expect(fitsBox(LONG, MESSAGE_BOXES[key]), key).toBe(true);
    }
  });

  it("every failure message fits the Player's box and VodPlay's card", () => {
    for (const m of failures()) expect(fitsBox(m, MESSAGE_BOXES.player), m).toBe(true);
    for (const m of failures()) expect(fitsBox(m, MESSAGE_BOXES.vodCard), m).toBe(true);
  });

  it('all boxes draw body text on LINE.body lines', () => {
    for (const [key, b] of Object.entries(MESSAGE_BOXES)) expect(b.lineH, key).toBe(LINE.body);
    expect(Object.keys(MESSAGE_BOXES)).not.toContain('vodCardSmall');
  });

  it("the Player's box and VodPlay's card hold the characters of their width at about 0.55 em", () => {
    const widths = { player: 1020, vodCard: 920 } as const;
    for (const [key, w] of Object.entries(widths)) {
      expect(MESSAGE_BOXES[key as keyof typeof widths].charsPerLine, key).toBe(Math.floor(w / (26 * 0.55)));
    }
  });

  it('every box keeps its lines inside its height', () => {
    const heights = { preview: 331, guide: 270, live: 234, player: 206, vodCard: 124 } as const;
    for (const [key, h] of Object.entries(heights)) {
      const b = MESSAGE_BOXES[key as keyof typeof MESSAGE_BOXES];
      expect(b.maxLines * b.lineH, key).toBeLessThanOrEqual(h);
    }
  });
});

describe('live box (416 x 234 mini window)', () => {
  const limit = failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 });
  const messages = [
    failureText({ reason: 'unavailable' }),
    failureText({ reason: 'unavailable', httpStatus: 404 }),
    failureText({ reason: 'unsupported' }),
    failureText({ reason: 'gone', httpStatus: 404 }),
    failureText({ reason: 'refused', httpStatus: 429 }),
    failureText({ reason: 'refused', httpStatus: 403 }),
    limit,
    COOLDOWN_TEXT,
  ];

  it('every preview message fits, the account-limit refusal included (one short form for every box)', () => {
    for (const m of messages) expect(fitsBox(m, MESSAGE_BOXES.live), m).toBe(true);
  });
});
