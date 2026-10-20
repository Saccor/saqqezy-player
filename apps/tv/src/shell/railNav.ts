import { batch } from 'solid-js';
import { tabParams, type TabId } from '../vod/tabLogic.ts';
import { railFromNested, railNavigation, type NestedRailStep, type RailBelow, type RailId, type RailNav } from './railLogic.ts';
import { router } from './router.ts';

function run(nav: RailNav | Exclude<NestedRailStep, { action: 'pop' }>, back: () => void): void {
  if (nav.action === 'pushScreen') router.push(nav.screen);
  else if (nav.action === 'replaceScreen') router.replace(nav.screen);
  else if (nav.action === 'back') back();
  else if (nav.action === 'replace') router.replace(nav.to.screen, tabParams(nav.to));
  else if (nav.action === 'push') router.push(nav.to.screen, tabParams(nav.to));
}

/** Runs a rail choice: Search and Settings are pushed; tabs move like the old tab bar (`back` returns to Live TV). */
export function goRail(from: TabId, to: RailId, back: () => void): void {
  run(railNavigation(from, to), back);
}

/**
 * Runs nested-rail steps in one batch, so the shell renders only the final screen, not the ones revealed in between.
 * A pop that ends the steps lands on that screen's own tab: it comes back with the rail focused, like any tab reached
 * from the rail.
 */
function runSteps(steps: NestedRailStep[], back: () => void): void {
  batch(() => {
    steps.forEach((step, i) => {
      if (step.action === 'pop') router.back(i === steps.length - 1 ? { focus: 'rail' } : undefined);
      else run(step, back);
    });
  });
}

/**
 * Runs a rail choice on a nested screen (the library grid) whose screen below is the tab `below`: tabs pop the nested
 * screen, then move as that screen would (`back` is its Back to Live TV).
 */
export function goRailNested(below: TabId, to: RailId, back: () => void): void {
  runSteps(railFromNested(below, to), back);
}

/**
 * Runs a rail choice on Search or Settings (`below` from `railBelow`): Search and Settings replace each other, a tab
 * pops it (and a library grid under it), then moves as the screen below would.
 */
export function goRailFrom(from: 'search' | 'settings', below: RailBelow | undefined, to: RailId, back: () => void): void {
  runSteps(railFromNested(from, below, to), back);
}
