import type { PlatformId } from './host.ts';

export type LogicalKey =
  | 'Up' | 'Down' | 'Left' | 'Right' | 'Ok' | 'Back' | 'Menu' | 'Info' | 'ChannelUp' | 'ChannelDown'
  | 'PlayPause' | 'Play' | 'Pause' | 'Stop' | 'FastForward' | 'Rewind'
  | 'VolumeUp' | 'VolumeDown' | 'Mute'
  | 'Red' | 'Green' | 'Yellow' | 'Blue' | `Digit${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export type KeyTable =
  | { by: 'key'; names: Readonly<Record<string, LogicalKey>> }
  | { by: 'code'; codes: Readonly<Record<number, LogicalKey>> };

const MEDIA_KEY_NAMES: Record<string, LogicalKey> = {
  MediaPlayPause: 'PlayPause', MediaPlay: 'Play', MediaPause: 'Pause', MediaStop: 'Stop',
  MediaFastForward: 'FastForward', MediaRewind: 'Rewind', MediaTrackNext: 'ChannelUp', MediaTrackPrevious: 'ChannelDown',
};
const BROWSER_KEYS: Record<string, LogicalKey> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Ok', Backspace: 'Back', Escape: 'Back', m: 'Menu', i: 'Info',
  PageUp: 'ChannelUp', PageDown: 'ChannelDown', ' ': 'PlayPause',
  F1: 'Red', F2: 'Green', F3: 'Yellow', F4: 'Blue',
  // AudioVolumeUp/Down/Mute are deliberately NOT mapped here. A mapped key is preventDefault'ed and notifies
  // `onLogicalKey`, and nothing handles volume yet, so it would flip pointer mode and bump the VOD overlay on
  // the desktop dev path. The `LogicalKey` members stay; the PC plan maps them when app volume is wired.
  ...MEDIA_KEY_NAMES,
};
/** Android TV WebView `KeyboardEvent.key` values (Chromium's Android key-code mapping); verified on device by the Android plan. */
const ANDROID_KEYS: Record<string, LogicalKey> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Ok',
  GoBack: 'Back', BrowserBack: 'Back', Escape: 'Back', ContextMenu: 'Menu', Info: 'Info',
  ChannelUp: 'ChannelUp', ChannelDown: 'ChannelDown',
  ColorF0Red: 'Red', ColorF1Green: 'Green', ColorF2Yellow: 'Yellow', ColorF3Blue: 'Blue', Guide: 'Green',
  ...MEDIA_KEY_NAMES,
};
const COMMON_CODES: Record<number, LogicalKey> = {
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 13: 'Ok', 457: 'Info',
  403: 'Red', 404: 'Green', 405: 'Yellow', 406: 'Blue', 10135: 'Menu',
  415: 'Play', 19: 'Pause', 413: 'Stop', 417: 'FastForward', 412: 'Rewind',
};
const TIZEN_CODES: Record<number, LogicalKey> = {
  ...COMMON_CODES, 10009: 'Back', 427: 'ChannelUp', 428: 'ChannelDown', 10252: 'PlayPause', 18: 'Menu',
  10233: 'ChannelUp', 10232: 'ChannelDown',
};
const WEBOS_CODES: Record<number, LogicalKey> = { ...COMMON_CODES, 461: 'Back', 33: 'ChannelUp', 34: 'ChannelDown' };

export function keyTableFor(id: PlatformId): KeyTable {
  if (id === 'tizen') return { by: 'code', codes: TIZEN_CODES };
  if (id === 'webos') return { by: 'code', codes: WEBOS_CODES };
  return { by: 'key', names: id === 'androidtv' ? ANDROID_KEYS : BROWSER_KEYS };
}

/** Tizen: codes read at start from `tvinputdevice.getKey(name).code` win over the defaults. */
export function withCodes(table: KeyTable, extra: Readonly<Record<number, LogicalKey>>): KeyTable {
  if (table.by !== 'code') return table;
  return { by: 'code', codes: { ...table.codes, ...extra } };
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function digit(n: number): LogicalKey {
  return `Digit${n as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
}

export function mapKey(table: KeyTable, e: { key: string; keyCode: number }): LogicalKey | undefined {
  if (table.by === 'key') {
    if (/^[0-9]$/.test(e.key)) return digit(Number(e.key));
    // Own properties only, so inherited names such as 'constructor' or '__proto__' never match
    // (hasOwnProperty.call, not Object.hasOwn: that is Chromium 93+, newer than older TV engines).
    if (hasOwn(table.names, e.key)) return table.names[e.key];
    const lower = e.key.toLowerCase();
    return hasOwn(table.names, lower) ? table.names[lower] : undefined;
  }
  if (e.keyCode >= 48 && e.keyCode <= 57) return digit(e.keyCode - 48);
  return hasOwn(table.codes, String(e.keyCode)) ? table.codes[e.keyCode] : undefined;
}

export const TIZEN_KEYS_TO_REGISTER: readonly string[] = [
  'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
  'Info', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
  'MediaTrackPrevious', 'MediaTrackNext', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];
