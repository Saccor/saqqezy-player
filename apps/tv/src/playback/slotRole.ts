/**
 * What a playback slot is doing right now. `single`: the single-view player (the primary slot outside multiview): the
 * user's live delay, learned live targets, today's refusal handling. `window`: a multiview window (every slot while
 * multiview is open): the `stable` delay, nothing learned, refusals stop only that window.
 */
export type SlotRole = 'single' | 'window';

export function slotRole(n: number, primary: number, multiview: boolean): SlotRole {
  return !multiview && n === primary ? 'single' : 'window';
}
