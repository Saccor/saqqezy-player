/**
 * Where the VOD player's focus goes: the screen (root), the controls' timeline and bar (only while the controls show),
 * and the centre card. Every move waits for this tick (a node drawn by the same change exists only after it) and
 * never happens after the screen left.
 */
import type { ElementNode } from '@lightningtv/solid';
import type { VodCore } from './createVodCore.ts';

export function createVodFocus(c: VodCore) {
  const { bump, visible } = c;
  let root: ElementNode | undefined;
  let barNode: ElementNode | undefined;
  let timelineNode: ElementNode | undefined;
  let cardNode: ElementNode | undefined;
  let barFocused = false;
  let timelineFocused = false;

  return {
    rootRef: (el: ElementNode) => { root = el; },
    barRef: (el: ElementNode) => { barNode = el; },
    timelineRef: (el: ElementNode) => { timelineNode = el; },
    cardRef: (el: ElementNode) => { cardNode = el; },
    root: () => root,
    onBarFocus: (f: boolean) => { barFocused = f; },
    onTimelineFocus: (f: boolean) => { timelineFocused = f; },
    /** The bar or the timeline has the focus (it must move off them when the controls hide). */
    controlsFocused: () => barFocused || timelineFocused,
    /** Takes the focus at once (the screen's first frame). */
    focusRootNow: () => { root?.setFocus(); },
    focusRoot: () => queueMicrotask(() => { if (c.alive) root?.setFocus(); }),
    focusCard: () => queueMicrotask(() => { if (c.alive) cardNode?.setFocus(); }),
    /** Shows the overlay and puts the focus on its timeline (the overlay's first row). */
    focusTimeline: () => {
      bump();
      queueMicrotask(() => { if (c.alive && visible()) timelineNode?.setFocus(); });
      return true;
    },
    focusBar: () => {
      bump();
      queueMicrotask(() => { if (c.alive && visible()) barNode?.setFocus(); });
      return true;
    },
    /** After an overlay closes: the bar when it still shows, else the root. */
    focusBarOrRoot: () => {
      queueMicrotask(() => {
        if (!c.alive) return;
        if (visible() && barNode) barNode.setFocus();
        else root?.setFocus();
      });
    },
  };
}
