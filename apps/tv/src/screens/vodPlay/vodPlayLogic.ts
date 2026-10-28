/** Pure rules of the VOD player screen's card (no Solid, no engine). */
import type { CatchupPlayable } from '@iptv/app-api';
import { endCardActions } from '../../vod/catchupLogic.ts';
import { CATCHUP_COPY, COMMON_COPY, VOD_COPY } from '../../copy.ts';

/** A card button: its action id, label and width. */
export interface CardAction { id: string; label: string; width: number }

/**
 * The centre card's buttons: Not available (Watch live, Back), the catch-up end card (`endCardActions`), a failure
 * (Try again), else the next-episode countdown (Play now, Cancel).
 */
export function cardActions(s: { notAvail: boolean; endCard: boolean; next: CatchupPlayable['next']; failed: boolean }): CardAction[] {
  if (s.notAvail) return [{ id: 'live', label: CATCHUP_COPY.watchLive, width: 260 }, { id: 'back', label: COMMON_COPY.back, width: 220 }];
  if (s.endCard) return endCardActions(s.next).map((a) => ({ id: a.id, label: a.label, width: a.id === 'next' ? 420 : a.id === 'live' ? 260 : 220 }));
  return s.failed
    ? [{ id: 'retry', label: COMMON_COPY.tryAgain, width: 260 }]
    : [{ id: 'nextNow', label: VOD_COPY.playNow, width: 260 }, { id: 'cancel', label: COMMON_COPY.cancel, width: 220 }];
}

/** The card's button row is centred: its left x in a card `cardW` wide (buttons 16 apart). */
export function cardActionsX(actions: readonly { width: number }[], cardW: number): number {
  return (cardW - actions.reduce((w, a) => w + a.width + 16, -16)) / 2;
}

/** The status line over the video: no status (an open held by a cooldown or the open-rate cap) reads as loading. */
export function vodStatusText(s: { kind: string } | undefined): string {
  return s === undefined || s.kind === 'loading' ? 'Loading…' : s.kind === 'reconnecting' ? 'Reconnecting…' : '';
}
