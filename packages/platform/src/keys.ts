export type LogicalKey =
  | 'Up' | 'Down' | 'Left' | 'Right' | 'Ok' | 'Back' | 'Menu' | 'Info' | 'ChannelUp' | 'ChannelDown'
  | 'PlayPause' | 'Red' | 'Green' | 'Yellow' | 'Blue' | `Digit${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type PlatformId = 'browser' | 'tizen' | 'webos';

export function detectPlatform(ua: string, globals: { tizen?: unknown; webOS?: unknown }): PlatformId {
  if (globals.tizen !== undefined || /tizen/i.test(ua)) return 'tizen';
  if (globals.webOS !== undefined || /web0s|webos/i.test(ua)) return 'webos';
  return 'browser';
}

const BROWSER_KEYS: Record<string, LogicalKey> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Ok', Backspace: 'Back', Escape: 'Back', m: 'Menu', i: 'Info',
  PageUp: 'ChannelUp', PageDown: 'ChannelDown', ' ': 'PlayPause',
  F1: 'Red', F2: 'Green', F3: 'Yellow', F4: 'Blue',
};

const COMMON_CODES: Record<number, LogicalKey> = {
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 13: 'Ok', 457: 'Info',
  403: 'Red', 404: 'Green', 405: 'Yellow', 406: 'Blue', 10135: 'Menu',
};
const TIZEN_CODES: Record<number, LogicalKey> = {
  ...COMMON_CODES, 10009: 'Back', 427: 'ChannelUp', 428: 'ChannelDown', 10252: 'PlayPause', 18: 'Menu',
};
const WEBOS_CODES: Record<number, LogicalKey> = {
  ...COMMON_CODES, 461: 'Back', 33: 'ChannelUp', 34: 'ChannelDown',
};

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function digit(n: number): LogicalKey {
  return `Digit${n as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
}

export function mapKey(platform: PlatformId, e: { key: string; keyCode: number }): LogicalKey | undefined {
  if (platform === 'browser') {
    if (/^[0-9]$/.test(e.key)) return digit(Number(e.key));
    // Own properties only, so inherited names such as 'constructor' or '__proto__' never match
    // (hasOwnProperty.call, not Object.hasOwn: that is Chromium 93+, newer than older TV engines).
    if (hasOwn(BROWSER_KEYS, e.key)) return BROWSER_KEYS[e.key];
    const lower = e.key.toLowerCase();
    return hasOwn(BROWSER_KEYS, lower) ? BROWSER_KEYS[lower] : undefined;
  }
  if (e.keyCode >= 48 && e.keyCode <= 57) return digit(e.keyCode - 48);
  return (platform === 'tizen' ? TIZEN_CODES : WEBOS_CODES)[e.keyCode];
}

export const TIZEN_KEYS_TO_REGISTER: string[] = [
  'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
  'Info', 'MediaPlayPause', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];
