import type { PlatformId } from './host.ts';
import { keyTableFor, TIZEN_KEYS_TO_REGISTER, type KeyTable } from './keys.ts';

/** Everything that differs per platform, read once at start. Spec §1.1. */
export interface PlatformProfile {
  id: PlatformId;
  isTv: boolean;
  keys: KeyTable;
  pointer: boolean;
  filePicker: boolean;
  volumeUi: boolean;
  rateCatchUp: boolean;
  clipboard: boolean;
  debugHud: boolean;
  registerKeys: readonly string[];
  /** The Play key pauses when already playing (LG App Self Checklist). */
  playKeyToggles: boolean;
}

export function profileFor(id: PlatformId): PlatformProfile {
  const isTv = id === 'tizen' || id === 'webos' || id === 'androidtv';
  const desk = !isTv;
  return Object.freeze({
    id,
    isTv,
    keys: keyTableFor(id),
    pointer: id !== 'tizen' && id !== 'androidtv',
    filePicker: desk,
    volumeUi: desk,
    // androidtv: off until the Android plan proves Media3 keeps audio at rate != 1.
    rateCatchUp: desk,
    clipboard: desk,
    debugHud: desk,
    registerKeys: id === 'tizen' ? TIZEN_KEYS_TO_REGISTER : [],
    playKeyToggles: id === 'webos',
  });
}
