import { describe, expect, it } from 'vitest';
import { detectPlatform, mapKey, TIZEN_KEYS_TO_REGISTER, type LogicalKey, type PlatformId } from '../src/index.ts';

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
    expect(mapKey('browser', { key, keyCode: 0 })).toBe(expected);
  });
  it('browser letter keys are case-insensitive (M, I) and ignore inherited property names', () => {
    expect(mapKey('browser', { key: 'M', keyCode: 0 })).toBe('Menu');
    expect(mapKey('browser', { key: 'I', keyCode: 0 })).toBe('Info');
    expect(mapKey('browser', { key: 'constructor', keyCode: 0 })).toBeUndefined();
    expect(mapKey('browser', { key: '__proto__', keyCode: 0 })).toBeUndefined();
  });
  it.each(tizenCases)('tizen keyCode %i -> %s', (keyCode, expected) => {
    expect(mapKey('tizen', { key: '', keyCode })).toBe(expected);
  });
  it.each(webosCases)('webos keyCode %i -> %s', (keyCode, expected) => {
    expect(mapKey('webos', { key: '', keyCode })).toBe(expected);
  });
  it.each(['browser', 'tizen', 'webos'] as PlatformId[])('%s returns undefined for unknown keys', (p) => {
    expect(mapKey(p, { key: 'q', keyCode: 81 })).toBeUndefined();
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
