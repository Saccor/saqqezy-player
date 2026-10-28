/**
 * Multiview's window menu (OK, Menu or right click on a window): Retry or Retry now (and "Watch this one instead" when
 * the source is at its limit) for a failed window, then the window items (`menuItems`), then Cancel. Not unit-tested:
 * the items and the state changes are pure (mvLogic.ts).
 */
import { createMemo } from 'solid-js';
import type { MenuItem } from '../../components/sheetLogic.ts';
import { COMMON_COPY, MULTIVIEW_COPY } from '../../copy.ts';
import {
  closeWindow, enterFullScreen, equalSize, makeLarge, menuItems, togglePin, type MenuId, type MvState, type MvWindow,
} from './mvLogic.ts';
import type { MvHealth } from './mvHealth.ts';
import type { MultiviewSession } from './session.ts';

export type MenuAction = MenuId | 'retry' | 'retryNow' | 'watchInstead' | 'cancel';

export function createMvMenu(d: {
  state: () => MvState | undefined;
  /** The window the menu is open on. */
  menu: () => number | undefined;
  health: MvHealth;
  canAdd: () => { ok: true } | { ok: false; reason: string };
  update: (next: MvState) => void;
  session: MultiviewSession;
  /** Leaves multiview (`keep`: the window that plays on full screen). */
  leave: (keep?: MvWindow) => void;
  closeMenu: () => void;
  /** The channel picker: to add a window, or to change window `index`'s channel. */
  openPicker: (index?: number) => void;
}) {
  const menuEntries = createMemo<MenuItem<MenuAction>[]>(() => {
    const s = d.state();
    const i = d.menu();
    if (!s || i === undefined) return [];
    const out: MenuItem<MenuAction>[] = [];
    if (d.health.failure(i)?.retryNow) out.push({ action: 'retryNow', label: MULTIVIEW_COPY.retry });
    else if (d.health.failure(i)?.retry.enabled) {
      // A plain Retry stays offered beside it: the app warns, it never blocks (decision 12.2).
      if (d.health.retryKind(i) === 'watchInstead') out.push({ action: 'watchInstead', label: MULTIVIEW_COPY.watchInstead });
      out.push({ action: 'retry', label: MULTIVIEW_COPY.retry });
    }
    for (const it of menuItems(s, i, d.canAdd())) out.push({ action: it.id, label: it.disabled ? `${it.label}: ${it.disabled}` : it.label });
    out.push({ action: 'cancel', label: COMMON_COPY.cancel });
    return out;
  });

  const choose = (action: MenuAction) => {
    const s = d.state();
    const i = d.menu();
    if (!s || i === undefined) { d.closeMenu(); return; }
    if (action === 'addChannel') {
      if (d.canAdd().ok) d.openPicker();
      return;
    }
    if (action === 'changeChannel') { d.openPicker(i); return; }
    d.closeMenu();
    // Acting on any window: a pending "Watch this one instead" opens nothing later (it starts again below if chosen).
    if (action !== 'cancel') d.health.watch.cancel();
    if (action === 'retry') {
      // The user's own Retry: a refusal mark left by a "Watch this one instead" reopen is not its to keep.
      const w = s.windows[i];
      if (w) d.health.forgetReopen(w.slot);
      d.health.retry(i);
    } else if (action === 'retryNow') d.health.retryNow(i);
    else if (action === 'watchInstead') d.health.watchInstead(i);
    else if (action === 'fullScreen') d.update(enterFullScreen(s, i));
    else if (action === 'makeLarge') d.update(makeLarge(s, i));
    else if (action === 'equalSize') d.update(equalSize(s));
    else if (action === 'keepSound' || action === 'soundFollows') d.update(togglePin(s, i));
    else if (action === 'closeWindow') {
      const w = s.windows[i];
      if (w) {
        d.health.forgetReopen(w.slot);
        d.session.close(w);
        d.health.unyield(w.slot);
      }
      const next = closeWindow(s, i);
      if ('leave' in next) d.leave(next.leave);
      else d.update(next);
    }
  };

  return { menuEntries, choose };
}
