import { describe, expect, it } from 'vitest';
import { failureText } from '../playback/failureText.ts';
import { COOLDOWN_TEXT } from '../state/cooldownLogic.ts';
import { MESSAGE_BOXES, fitsBox, messageLines, messageTop, stackedMessage } from './messageFit.ts';

describe('stackedMessage', () => {
  it('puts the hint under the last line of the text, the whole block centred and inside the box', () => {
    // Home's preview: 588 × 331, text 524 wide at body size; the Player: 1100 × 240 at heading size.
    for (const [w, h, size] of [[524, 331, 26], [1036, 240, 32]] as const) {
      for (const text of ['Short.', COOLDOWN_TEXT, `${COOLDOWN_TEXT} ${COOLDOWN_TEXT}`]) {
        const s = stackedMessage(text, { width: w, fontSize: size, maxLines: 3 }, h, 22);
        expect(s.hintY, text).toBeGreaterThanOrEqual(s.textY + s.lines * s.lineH);
        expect(s.textY).toBeGreaterThanOrEqual(0);
        expect(s.hintY + 22 * 1.3).toBeLessThanOrEqual(h);
      }
    }
  });

  it("counts the cooldown copy as three lines in Home's preview (it wrapped into the hint before)", () => {
    expect(stackedMessage(COOLDOWN_TEXT, { width: 524, fontSize: 26, maxLines: 3 }, 331, 22).lines).toBe(3);
  });
});

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
    const heights = { preview: 331, guide: 270, live: 234, player: 206, vodCard: 124, vodCardSmall: 124 } as const;
    for (const [key, h] of Object.entries(heights)) {
      const b = MESSAGE_BOXES[key as keyof typeof MESSAGE_BOXES];
      expect(b.maxLines * b.lineH, key).toBeLessThanOrEqual(h);
    }
  });
});

describe('live box (416 x 234 mini window)', () => {
  const limit = failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 }, 'channel');
  const messages = [
    failureText({ reason: 'unavailable' }, 'channel'),
    failureText({ reason: 'unavailable', httpStatus: 404 }, 'channel'),
    failureText({ reason: 'unsupported' }, 'channel'),
    failureText({ reason: 'gone', httpStatus: 404 }, 'channel'),
    failureText({ reason: 'refused', httpStatus: 429 }, 'channel'),
    failureText({ reason: 'refused', httpStatus: 403 }, 'channel'),
    limit,
    COOLDOWN_TEXT,
  ];

  it('every preview message fits; the account-limit refusal uses its compact form', () => {
    const compact = failureText({ reason: 'refused', httpStatus: 403, maxConnections: 10 }, 'channel', true);
    const all = [...messages.filter((m) => m !== limit), compact];
    for (const m of all) expect(fitsBox(m, MESSAGE_BOXES.live), m).toBe(true);
    expect(fitsBox(limit, MESSAGE_BOXES.live)).toBe(false);
  });
});
