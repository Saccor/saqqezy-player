import { describe, expect, it } from 'vitest';
import { CATCHUP_COPY, COMMON_COPY, VOD_COPY } from '../../copy.ts';
import { cardActions, cardActionsX, vodStatusText } from './vodPlayLogic.ts';

describe('cardActions', () => {
  it('offers Watch live and Back when the programme is not available', () => {
    expect(cardActions({ notAvail: true, endCard: true, next: undefined, failed: true })).toEqual([
      { id: 'live', label: CATCHUP_COPY.watchLive, width: 260 },
      { id: 'back', label: COMMON_COPY.back, width: 220 },
    ]);
  });

  it('offers the next programme first on the end card, wider than the others', () => {
    const next = { start: 1, stop: 2, title: 'Later' };
    expect(cardActions({ notAvail: false, endCard: true, next, failed: false })).toEqual([
      { id: 'next', label: CATCHUP_COPY.nextTitle('Later'), width: 420 },
      { id: 'live', label: CATCHUP_COPY.watchLive, width: 260 },
      { id: 'back', label: COMMON_COPY.back, width: 220 },
    ]);
  });

  it('offers Try again on a failure', () => {
    expect(cardActions({ notAvail: false, endCard: false, next: undefined, failed: true })).toEqual([
      { id: 'retry', label: COMMON_COPY.tryAgain, width: 260 },
    ]);
  });

  it('offers Play now and Cancel for the next-episode countdown', () => {
    expect(cardActions({ notAvail: false, endCard: false, next: undefined, failed: false })).toEqual([
      { id: 'nextNow', label: VOD_COPY.playNow, width: 260 },
      { id: 'cancel', label: COMMON_COPY.cancel, width: 220 },
    ]);
  });
});

describe('cardActionsX', () => {
  it('centres the buttons with 16 px between them', () => {
    expect(cardActionsX([{ width: 260 }, { width: 220 }], 1000)).toBe((1000 - 496) / 2);
    expect(cardActionsX([{ width: 260 }], 1000)).toBe(370);
  });
});

describe('vodStatusText', () => {
  it('reads a held open and loading as loading, reconnecting as such, anything else as nothing', () => {
    expect(vodStatusText(undefined)).toBe('Loading…');
    expect(vodStatusText({ kind: 'loading' })).toBe('Loading…');
    expect(vodStatusText({ kind: 'reconnecting' })).toBe('Reconnecting…');
    expect(vodStatusText({ kind: 'playing' })).toBe('');
  });
});
