import { tabParams, type TabId } from '../vod/tabLogic.ts';
import { railNavigation, type RailId } from './railLogic.ts';
import { router } from './router.ts';

/** Runs a rail choice: Search and Settings are pushed; tabs move like the old tab bar (`back` returns to Live TV). */
export function goRail(from: TabId, to: RailId, back: () => void): void {
  const nav = railNavigation(from, to);
  if (nav.action === 'pushScreen') router.push(nav.screen);
  else if (nav.action === 'back') back();
  else if (nav.action === 'replace') router.replace(nav.to.screen, tabParams(nav.to));
  else if (nav.action === 'push') router.push(nav.to.screen, tabParams(nav.to));
}
