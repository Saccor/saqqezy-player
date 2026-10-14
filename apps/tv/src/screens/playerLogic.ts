import type { AspectMode, SupervisorStatus } from '@iptv/player';

/** How the Player shows the supervisor status: a small toast, a centred message, or nothing. */
export function playerStatusText(s: SupervisorStatus | undefined): { kind: 'toast' | 'centre'; text: string } | undefined {
  if (!s) return undefined;
  if (s.kind === 'reconnecting') return { kind: 'toast', text: `Reconnecting… (${s.attempt}/3)` };
  if (s.kind === 'failed') {
    return {
      kind: 'centre',
      text: s.reason === 'unsupported'
        ? "This stream's format isn't supported on this device"
        : "This channel isn't available right now",
    };
  }
  return undefined;
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
