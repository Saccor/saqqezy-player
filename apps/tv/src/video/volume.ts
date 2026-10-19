import { createSignal } from 'solid-js';
import { platformId } from '../state/appState.ts';
import { player } from '../playback/playback.ts';
import { isTvPlatform } from './engineConfig.ts';
import {
  effectiveVolume, levelAt, parseVolume, serializeVolume, stepVolume, toggleMute, type VolumeState,
} from './volumeLogic.ts';

/**
 * The app's volume: one level for live and VOD, kept on this device. Only where the app owns the sound (HTML5 off TVs:
 * the browser and desktop); TVs keep their remote's volume keys, so nothing here shows or acts there.
 */
const STORE_KEY = 'iptv.volume';

const store = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export const volumeSupported = player.setVolume !== undefined && !isTvPlatform(platformId);

const initial = (() => {
  try {
    return parseVolume(store()?.getItem(STORE_KEY));
  } catch {
    return parseVolume(undefined);
  }
})();
/** How long the on-screen indicator stays after a change. */
const RECENT_MS = 2000;

const [state, setState] = createSignal<VolumeState>(initial);
const [recent, setRecent] = createSignal(false);
let recentTimer: ReturnType<typeof setTimeout> | undefined;

export const volume = state;
/** True for 2 s after the volume changed (the on-screen indicator shows). */
export const volumeRecent = recent;

function apply(next: VolumeState): void {
  setState(next);
  setRecent(true);
  if (recentTimer !== undefined) clearTimeout(recentTimer);
  recentTimer = setTimeout(() => setRecent(false), RECENT_MS);
  player.setVolume?.(effectiveVolume(next));
  try {
    store()?.setItem(STORE_KEY, serializeVolume(next));
  } catch {
    // Storage full or blocked: the volume still applies for this session.
  }
}

if (volumeSupported) player.setVolume?.(effectiveVolume(initial));

export function volumeStep(dir: 1 | -1): void {
  if (volumeSupported) apply(stepVolume(state(), dir));
}

export function volumeToggleMute(): void {
  if (volumeSupported) apply(toggleMute(state()));
}

/** A click or drag on the slider, `fraction` along it. */
export function volumeSet(fraction: number): void {
  if (volumeSupported) apply(levelAt(fraction));
}
