import type { AspectMode, LiveInfo, SupervisorStatus } from '@iptv/player';
import { POINTER_BAR_H } from '../input/pointerLogic.ts';
import { LAYOUT } from '../shell/theme.ts';

/** How the Player shows the supervisor status: a small toast, a centred message, or nothing. */
export function playerStatusText(s: SupervisorStatus | undefined): { kind: 'toast' | 'centre'; text: string } | undefined {
  if (!s) return undefined;
  if (s.kind === 'reconnecting') return { kind: 'toast', text: 'Reconnecting…' };
  if (s.kind === 'failed') {
    return {
      kind: 'centre',
      text: s.reason === 'unsupported'
        ? "This stream's format isn't supported on this device"
        : s.reason === 'refused'
          ? 'Your source refused this stream'
          : "This channel isn't available right now",
    };
  }
  return undefined;
}

/** Beyond the target by more than this, the banner shows "−N s" and OK jumps to live. */
const PILL_BEHIND_MARGIN_S = 3;

/**
 * The banner's live pill: "LIVE", or "−N s" with an "OK: Go live" hint when the stream is behind its target.
 * The delay is the distance to the live edge, the value the controller steers by (never the stream clock).
 * Raw TS only knows its buffer, so it always shows "LIVE" (never a delay it cannot measure). A non-live stream
 * (file/VOD) shows no pill.
 */
export function livePill(status: SupervisorStatus | undefined, info: LiveInfo | undefined): { text: string; hint?: string } | undefined {
  if (status?.kind !== 'playing' || info?.isLive === false) return undefined;
  if (info && info.source !== 'buffer' && info.behindLiveS !== undefined
    && info.behindLiveS > info.targetS + PILL_BEHIND_MARGIN_S) {
    return { text: `−${Math.round(info.behindLiveS)} s`, hint: 'OK: Go live' };
  }
  return { text: 'LIVE' };
}

export const ASPECT_MODES: readonly AspectMode[] = ['auto', '16:9', '4:3', 'zoom', 'stretch'];

export function nextAspect(mode: AspectMode): AspectMode {
  const i = ASPECT_MODES.indexOf(mode);
  return ASPECT_MODES[(i + 1) % ASPECT_MODES.length]!;
}

export function aspectLabel(mode: AspectMode): string {
  switch (mode) {
    case 'auto': return 'Auto';
    case 'zoom': return 'Zoom';
    case 'stretch': return 'Stretch';
    default: return mode;
  }
}

export function sleepLabel(minutes: number, left: number | undefined): string {
  if (minutes <= 0) return 'Off';
  return left === undefined ? `${minutes} min` : `${minutes} min (${left} left)`;
}

/**
 * `nowNextUpdated` for `changed`: the visible banner re-reads now/next when it shows the playing channel and
 * that channel is in the update (a zap preview of another channel is left alone).
 */
export function bannerNowNextStale(
  changed: readonly string[], playingId: string | undefined, shownId: string | undefined, bannerOn: boolean,
): boolean {
  return bannerOn && playingId !== undefined && shownId === playingId && changed.includes(playingId);
}

/** True while a modal layer owns the keys: the "Still watching?" dialog or the options menu. */
export function isModalOpen(sleepKind: string, menuPage: string | undefined): boolean {
  return sleepKind === 'asking' || menuPage != null;
}

/**
 * One monotonically increasing token shared by every channel jump and every zap press. A jump result is applied
 * only if nothing newer started since it began.
 */
export function createJumpGuard() {
  let token = 0;
  return {
    /** Starts a new action; all earlier ones become stale. */
    bump(): number { return ++token; },
    isCurrent(t: number): boolean { return t === token; },
  };
}

/** The pointer overlay's buttons (pointer mode only). */
export const PLAYER_POINTER_LABELS = {
  back: '← Back',
  channelUp: '▲ Ch+',
  channelDown: '▼ Ch−',
  previous: '⟲ Previous',
  info: 'ⓘ Info',
  options: '☰ Options',
  guide: '▦ Guide',
  window: '⛶ Window',
} as const;

/** The overlay shows in pointer mode; a modal (options menu, "Still watching?") hides it, so they never overlap. */
export function playerOverlayShown(pointerOn: boolean, modalOpen: boolean): boolean {
  return pointerOn && !modalOpen;
}

/** Whether the 3 s idle timer may hide the overlay now: not while the pointer is over its buttons, nor while a modal is open. */
export function playerAutoHide(c: { overButton: boolean; modalOpen: boolean }): boolean {
  return !c.overButton && !c.modalOpen;
}

/** The info banner moves up by the bottom row's height (plus a gap) while the row is shown, so the two never overlap. */
export function bannerLift(overlayShown: boolean): number {
  return overlayShown ? POINTER_BAR_H + LAYOUT.gap : 0;
}
