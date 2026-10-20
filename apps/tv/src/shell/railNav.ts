import { batch } from 'solid-js';
import { tabParams, type TabId } from '../vod/tabLogic.ts';
import { railFromNested, railNavigation, type RailId, type RailNav } from './railLogic.ts';
import { router } from './router.ts';

function run(nav: RailNav, back: () => void): void {
  if (nav.action === 'pushScreen') router.push(nav.screen);
  else if (nav.action === 'back') back();
  else if (nav.action === 'replace') router.replace(nav.to.screen, tabParams(nav.to));
  else if (nav.action === 'push') router.push(nav.to.screen, tabParams(nav.to));
}

/** Runs a rail choice: Search and Settings are pushed; tabs move like the old tab bar (`back` returns to Live TV). */
export function goRail(from: TabId, to: RailId, back: () => void): void {
  run(railNavigation(from, to), back);
}

/**
 * Runs a rail choice on a nested screen (the library grid) whose screen below is the tab `below`: tabs pop the nested
 * screen, then move as that screen would (`back` is its Back to Live TV). One batch, so the shell renders only the
 * final screen, not the one revealed in between.
 */
export function goRailNested(below: TabId, to: RailId, back: () => void): void {
  batch(() => {
    const steps = railFromNested(below, to);
    for (const step of steps) {
      // The screen below's own tab: it comes back with the rail focused, like any tab reached from the rail.
      if (step.action === 'pop') router.back(steps.length === 1 ? { focus: 'rail' } : undefined);
      else run(step, back);
    }
  });
}
