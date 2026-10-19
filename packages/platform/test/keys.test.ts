import { describe, expect, it } from 'vitest';
import { detectPlatform, keyTableFor, mapKey, TIZEN_KEY_NAMES, TIZEN_KEYS_TO_REGISTER, withCodes, type LogicalKey, type PlatformId } from '../src/index.ts';

const browserCases: Array<[string, LogicalKey]> = [
  ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
  ['Enter', 'Ok'], ['Backspace', 'Back'], ['Escape', 'Back'], ['m', 'Menu'], ['i', 'Info'],
  ['PageUp', 'ChannelUp'], ['PageDown', 'ChannelDown'], [' ', 'PlayPause'],
  ['F1', 'Red'], ['F2', 'Green'], ['F3', 'Yellow'], ['F4', 'Blue'],
  ['0', 'Digit0'], ['5', 'Digit5'], ['9', 'Digit9'],
];
const tizenCases: Array<[number, LogicalKey]> = [
  [37, 'Left'], [38, 'Up'], [39, 'Right'], [40, 'Down'], [13, 'Ok'], [10009, 'Back'],
  [427, 'ChannelUp'], [428, 'ChannelDown'], [457, 'Info'], [10252, 'PlayPause'],
  [403, 'Red'], [404, 'Green'], [405, 'Yellow'], [406, 'Blue'],
  [48, 'Digit0'], [57, 'Digit9'], [10135, 'Menu'], [18, 'Menu'],
];
const webosCases: Array<[number, LogicalKey]> = [
  [37, 'Left'], [38, 'Up'], [39, 'Right'], [40, 'Down'], [13, 'Ok'], [461, 'Back'],
  [33, 'ChannelUp'], [34, 'ChannelDown'], [457, 'Info'],
  [403, 'Red'], [404, 'Green'], [405, 'Yellow'], [406, 'Blue'],
  [48, 'Digit0'], [53, 'Digit5'], [57, 'Digit9'], [10135, 'Menu'],
];

describe('mapKey', () => {
  it.each(browserCases)('browser key %j -> %s', (key, expected) => {
    expect(mapKey(keyTableFor('browser'), { key, keyCode: 0 })).toBe(expected);
  });
  it('browser letter keys are case-insensitive (M, I) and ignore inherited property names', () => {
    expect(mapKey(keyTableFor('browser'), { key: 'M', keyCode: 0 })).toBe('Menu');
    expect(mapKey(keyTableFor('browser'), { key: 'I', keyCode: 0 })).toBe('Info');
    expect(mapKey(keyTableFor('browser'), { key: 'constructor', keyCode: 0 })).toBeUndefined();
    expect(mapKey(keyTableFor('browser'), { key: '__proto__', keyCode: 0 })).toBeUndefined();
  });
  it.each(tizenCases)('tizen keyCode %i -> %s', (keyCode, expected) => {
    expect(mapKey(keyTableFor('tizen'), { key: '', keyCode })).toBe(expected);
  });
  it.each(webosCases)('webos keyCode %i -> %s', (keyCode, expected) => {
    expect(mapKey(keyTableFor('webos'), { key: '', keyCode })).toBe(expected);
  });
  it.each(['browser', 'tizen', 'webos'] as PlatformId[])('%s returns undefined for unknown keys', (p) => {
    expect(mapKey(keyTableFor(p), { key: 'q', keyCode: 81 })).toBeUndefined();
  });
});

describe('detectPlatform', () => {
  it('detects tizen via global', () => {
    expect(detectPlatform('Mozilla/5.0', { tizen: {} })).toBe('tizen');
  });
  it('detects tizen via UA', () => {
    expect(detectPlatform('Mozilla/5.0 (SMART-TV; Tizen 7.0)', {})).toBe('tizen');
  });
  it('detects webos via global or UA', () => {
    expect(detectPlatform('Mozilla/5.0', { webOS: {} })).toBe('webos');
    expect(detectPlatform('Mozilla/5.0 (Web0S; Linux) webOS.TV-2023', {})).toBe('webos');
  });
  it('defaults to browser', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0) Chrome/120', {})).toBe('browser');
  });
});

describe('TIZEN_KEYS_TO_REGISTER', () => {
  it('lists the keys to register', () => {
    expect(TIZEN_KEYS_TO_REGISTER).toEqual([
      'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
      'Info', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'MediaTrackPrevious', 'MediaTrackNext', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ]);
  });
});

const mediaKeyNames: Array<[string, LogicalKey]> = [
  ['MediaPlayPause', 'PlayPause'], ['MediaPlay', 'Play'], ['MediaPause', 'Pause'], ['MediaStop', 'Stop'],
  ['MediaFastForward', 'FastForward'], ['MediaRewind', 'Rewind'], ['MediaTrackNext', 'ChannelUp'], ['MediaTrackPrevious', 'ChannelDown'],
];
const androidCases: Array<[string, LogicalKey]> = [
  ...mediaKeyNames,
  ['ArrowUp', 'Up'], ['Enter', 'Ok'], ['GoBack', 'Back'], ['BrowserBack', 'Back'], ['Escape', 'Back'],
  ['ContextMenu', 'Menu'], ['Info', 'Info'], ['ChannelUp', 'ChannelUp'], ['ChannelDown', 'ChannelDown'],
  ['ColorF0Red', 'Red'], ['ColorF1Green', 'Green'], ['ColorF2Yellow', 'Yellow'], ['ColorF3Blue', 'Blue'], ['Guide', 'Green'],
  ['0', 'Digit0'], ['7', 'Digit7'],
];
const tvMediaCodes: Array<[number, LogicalKey]> = [[415, 'Play'], [19, 'Pause'], [413, 'Stop'], [417, 'FastForward'], [412, 'Rewind']];

describe('media keys', () => {
  it.each(mediaKeyNames)('browser/desktop %s -> %s', (key, expected) => {
    expect(mapKey(keyTableFor('browser'), { key, keyCode: 0 })).toBe(expected);
    expect(mapKey(keyTableFor('desktop'), { key, keyCode: 0 })).toBe(expected);
  });
  it.each(androidCases)('androidtv %s -> %s', (key, expected) => {
    expect(mapKey(keyTableFor('androidtv'), { key, keyCode: 0 })).toBe(expected);
  });
  it('androidtv has no keyboard-only keys (Backspace, m, F1) and no volume keys', () => {
    for (const key of ['Backspace', 'm', 'F1', ' ', 'AudioVolumeUp']) expect(mapKey(keyTableFor('androidtv'), { key, keyCode: 0 })).toBeUndefined();
  });
  it('browser and desktop leave the volume keys unmapped until the app owns volume', () => {
    for (const id of ['browser', 'desktop'] as PlatformId[]) {
      for (const key of ['AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute']) {
        expect(mapKey(keyTableFor(id), { key, keyCode: 0 })).toBeUndefined();
      }
    }
  });
  it.each(tvMediaCodes)('tizen and webos code %i -> %s', (keyCode, expected) => {
    expect(mapKey(keyTableFor('tizen'), { key: '', keyCode })).toBe(expected);
    expect(mapKey(keyTableFor('webos'), { key: '', keyCode })).toBe(expected);
  });
  it('tizen track keys zap', () => {
    expect(mapKey(keyTableFor('tizen'), { key: '', keyCode: 10233 })).toBe('ChannelUp');
    expect(mapKey(keyTableFor('tizen'), { key: '', keyCode: 10232 })).toBe('ChannelDown');
  });
  it('withCodes overrides and adds codes without touching the original', () => {
    const base = keyTableFor('tizen');
    const t = withCodes(base, { 9999: 'Play', 415: 'Stop' });
    expect(mapKey(t, { key: '', keyCode: 9999 })).toBe('Play');
    expect(mapKey(t, { key: '', keyCode: 415 })).toBe('Stop');
    expect(mapKey(base, { key: '', keyCode: 9999 })).toBeUndefined();
  });
  it('withCodes on a key table returns it unchanged', () => {
    const t = keyTableFor('desktop');
    expect(withCodes(t, { 1: 'Play' })).toBe(t);
  });
  it('TIZEN_KEY_NAMES maps every media key name it registers', () => {
    for (const n of ['MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious']) {
      expect(TIZEN_KEY_NAMES[n]).toBeDefined();
      expect(TIZEN_KEYS_TO_REGISTER).toContain(n);
    }
  });
});
