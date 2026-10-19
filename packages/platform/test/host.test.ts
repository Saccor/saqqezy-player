import { describe, expect, it } from 'vitest';
import { detectPlatform, readHostInfo } from '../src/index.ts';

const desktop = { kind: 'desktop', protocol: 1, shellVersion: '0.9.0', engine: 'mpv', net: { base: 'iptvnet://localhost/', kinds: ['raw', 'image'] } };

describe('readHostInfo', () => {
  it('accepts a valid host object and keeps functions', () => {
    const exit = () => undefined;
    const h = readHostInfo({ ...desktop, exit });
    expect(h).toMatchObject({ kind: 'desktop', protocol: 1, shellVersion: '0.9.0', engine: 'mpv' });
    expect(h?.net).toEqual({ base: 'iptvnet://localhost/', kinds: ['raw', 'image'] });
    expect(h?.exit).toBe(exit);
  });
  it.each([
    undefined, null, 1, 'desktop', {}, { kind: 'tizen', protocol: 1, shellVersion: 'x' },
    { kind: 'desktop', protocol: '1', shellVersion: 'x' }, { kind: 'desktop', protocol: 1 },
  ])('rejects %j', (g) => expect(readHostInfo(g)).toBeUndefined());
  it('drops an invalid engine or net instead of rejecting the host', () => {
    const h = readHostInfo({ kind: 'androidtv', protocol: 1, shellVersion: '1', engine: 'vlc', net: { base: 5, kinds: [] } });
    expect(h).toEqual({ kind: 'androidtv', protocol: 1, shellVersion: '1' });
  });
  it('filters unknown net kinds', () => {
    expect(readHostInfo({ ...desktop, net: { base: 'x://y/', kinds: ['raw', 'evil', 'media'] } })?.net?.kinds).toEqual(['raw', 'media']);
  });
  it('keeps only safe device facts', () => {
    const h = readHostInfo({ ...desktop, device: { api: 34, lowRam: true, model: 'AFTKRT', webview: '120.0.6099', name: 'Living room TV ✨', addr: 'http://192.168.1.2', nested: { a: 1 }, 'bad key!': 1 } });
    // the emoji name, the URL, the nested object and the bad key are dropped
    expect(h?.device).toEqual({ api: 34, lowRam: true, model: 'AFTKRT', webview: '120.0.6099' });
  });
});

describe('detectPlatform', () => {
  it('prefers the injected host over the UA', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0) Chrome/130', { __IPTV_HOST__: desktop })).toBe('desktop');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 12) Chrome/120', { __IPTV_HOST__: { kind: 'androidtv', protocol: 1, shellVersion: '1' } })).toBe('androidtv');
  });
  it('keeps the TV detection', () => {
    expect(detectPlatform('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)', {})).toBe('tizen');
    expect(detectPlatform('x', { webOS: {} })).toBe('webos');
    expect(detectPlatform('Mozilla/5.0 (Web0S; Linux)', {})).toBe('webos');
  });
  it('never detects desktop or androidtv from the UA alone', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) Chrome/120', {})).toBe('browser');
    expect(detectPlatform('Tauri/2.0', {})).toBe('browser');
  });
});
