import { createSignal } from 'solid-js';
import type { NoticeEntry } from '../components/Notice.tsx';
import { autoHideDelay } from '../components/noticeLogic.ts';
import { onLogicalKey } from '../input/keys.ts';
import { TOAST_OVERLAY_ID, screenOverlayOpen, toastOnExpiry, toastOnShow, type ToastState } from './logic.ts';
import { router } from './router.ts';

/** Default precedence. Only background guide-refresh failures use a lower one (0), so they never interrupt. */
const TOAST_PRIORITY_NORMAL = 1;

const [state, setState] = createSignal<ToastState>({});
let timer: ReturnType<typeof setTimeout> | undefined;
let removeOverlay: (() => void) | undefined;
let shownAt = 0;
let lastKeyAt = -1;
onLogicalKey(() => { lastKeyAt = Date.now(); });

function stopTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** Back closed the toast: drop it and anything waiting behind it. */
function clear(): void {
  stopTimer();
  removeOverlay = undefined;
  setState({});
}

/** Waits until the auto-hide window (MOTION.autoHide, paused by key presses and open sheets) has run out. */
function arm(): void {
  stopTimer();
  const left = () => autoHideDelay({ shownAt, lastKeyAt, now: Date.now(), held: screenOverlayOpen(router.overlays()) });
  timer = setTimeout(() => (left() > 0 ? arm() : expire()), left());
}

/** (Re)starts the window and the Back layer for the toast now visible. */
function startWindow(): void {
  removeOverlay?.();
  removeOverlay = router.pushOverlay(TOAST_OVERLAY_ID, clear);
  shownAt = Date.now();
  arm();
}

function expire(): void {
  timer = undefined;
  const next = toastOnExpiry(state());
  setState(next);
  if (next.current) {
    startWindow();
  } else {
    const remove = removeOverlay;
    removeOverlay = undefined;
    remove?.();
  }
}

/**
 * Shows a toast as an info Notice (top right) for MOTION.autoHide. It is an overlay, so Back closes it before leaving the
 * screen. A toast with lower `priority` than the visible one waits until that one's window is up (see `toastOnShow`).
 */
export function showToast(message: string, priority = TOAST_PRIORITY_NORMAL): void {
  const prev = state().current;
  const next = toastOnShow(state(), { text: message, priority });
  setState(next);
  if (next.current !== prev) startWindow();
}

/** The toast now visible, as a Notice for `NoticeLayer`. */
export function toastNotice(): NoticeEntry | undefined {
  const t = state().current?.text;
  return t ? { id: TOAST_OVERLAY_ID, kind: 'info', text: t } : undefined;
}
