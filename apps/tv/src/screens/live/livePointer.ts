/**
 * Live TV's pointer (mouse, pointer remote), ported from the Guide's `onCellClick` / `onGridWheel` / `pageBy` and
 * Home's `clickVideo` and bottom row, plus the type-to-search hand-off. A click on a cell focuses it and acts like OK;
 * a right click opens the menu on it; the wheel moves rows (the horizontal wheel steps time). Not unit-tested: the
 * pure rules are `sameCell` and `liveTypedChar`.
 */
import { createEffect, onCleanup } from 'solid-js';
import type { PointerBarItem } from '../../components/PointerBar.tsx';
import { moveFocus } from '../../components/virtualWindow.ts';
import { captureTextInput } from '../../input/keys.ts';
import type { GridHit } from '../../input/pointerLogic.ts';
import { router } from '../../shell/router.ts';
import type { Block } from '../guideLogic.ts';
import { GUIDE_POINTER_LABELS } from '../guideLogic.ts';
import { HOME_POINTER_LABELS } from '../homeSearchLogic.ts';
import { liveTypedChar, sameCell, type LivePlace } from './liveLogic.ts';

export interface LivePointerDeps {
  row: () => number;
  place: () => LivePlace;
  /** Start of the focused programme block. */
  focusStart: () => number | undefined;
  total: () => number;
  viewStart: () => number;
  /** Focus to one of the screen's places (the grid node for 'grid' and 'channels'). */
  focusPlace: (p: LivePlace) => void;
  /** Moves the focused row (the details collapse). */
  setFocusRow: (i: number) => void;
  /** Moves the focused time inside the view (the details collapse). */
  focusTime: (t: number) => void;
  /** Left / Right on the grid's time axis; never leaves the grid. */
  stepTime: (dir: 1 | -1) => void;
  /** `‹ Earlier` / `Later ›`: the view by its whole span. */
  pageTime: (dir: 1 | -1) => void;
  ok: () => boolean;
  openMenu: () => boolean;
  /** The channel the mini video plays or is fetching. */
  videoChannel: () => string | undefined;
  /** Fullscreen on that channel. */
  openVideo: (id: string) => void;
}

export function createLivePointer(d: LivePointerDeps) {
  /** A layer (menu, picker, day choice, keyboard) owns the input. */
  const blocked = () => router.topOverlay() !== undefined;

  /** Focus to the hit cell, as the D-pad would move there; the focused cell stays as it is (its details too). */
  const focusHit = (hit: GridHit<Block>) => {
    const h = hit.area === 'channels' ? hit : { area: 'grid' as const, row: hit.row, start: hit.block.start };
    if (sameCell(h, { row: d.row(), place: d.place(), focusStart: d.focusStart() })) return;
    d.focusPlace(hit.area);
    d.setFocusRow(hit.row);
    if (hit.area === 'grid') d.focusTime(Math.max(hit.block.start, d.viewStart()));
  };

  /** A click: focus the cell, then OK (preview, fullscreen on the playing channel, catch-up or details). */
  const onCellClick = (hit: GridHit<Block>) => {
    if (blocked()) return;
    focusHit(hit);
    d.ok();
  };

  /** A right click: the one menu, on that cell. */
  const onCellMenu = (hit: GridHit<Block>) => {
    if (blocked()) return;
    focusHit(hit);
    d.openMenu();
  };

  /** The wheel moves rows like Up/Down; the horizontal (or Shift) wheel steps time like Left/Right on the grid. */
  const onWheel = (dy: number, dx: number) => {
    if (blocked() || d.total() === 0) return;
    if (d.place() !== 'grid' && d.place() !== 'channels') d.focusPlace('grid');
    if (dy !== 0) d.setFocusRow(moveFocus(d.row(), dy, d.total()));
    if (dx !== 0 && d.place() === 'grid') d.stepTime(dx > 0 ? 1 : -1);
  };

  /** A click on the mini video: fullscreen on the channel it plays (or is fetching). */
  const onVideoClick = () => {
    if (blocked()) return;
    const id = d.videoChannel();
    if (id !== undefined) d.openVideo(id);
  };

  /** The bottom row in pointer mode (the hint line is gone in phase 2). */
  const bar: PointerBarItem[] = [
    { id: 'earlier', label: GUIDE_POINTER_LABELS.earlier, onPress: () => { if (!blocked()) d.pageTime(-1); } },
    { id: 'later', label: GUIDE_POINTER_LABELS.later, onPress: () => { if (!blocked()) d.pageTime(1); } },
    { id: 'search', label: HOME_POINTER_LABELS.search, onPress: () => { if (!blocked()) router.push('search'); } },
    { id: 'settings', label: HOME_POINTER_LABELS.settings, onPress: () => { if (!blocked()) router.push('settings'); } },
  ];

  return { onCellClick, onCellMenu, onWheel, onVideoClick, bar };
}

/**
 * Hardware typing while `active` (the grid or the channel cell has focus, no layer is open): a letter or digit opens
 * Search seeded with it (`liveTypedChar`). Re-registered whenever `active` turns true again, since a keyboard's own
 * capture replaces this one while it is open.
 */
export function useTypeToSearch(active: () => boolean): void {
  createEffect(() => {
    if (!active()) return;
    const release = captureTextInput((e) => {
      if (!active() || router.topOverlay() !== undefined) return false;
      const ch = liveTypedChar(e);
      if (ch === undefined) return false;
      router.push('search', { query: ch });
      return true;
    });
    onCleanup(release);
  });
}
