import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileFor } from '@iptv/platform';
import { exitApp, rootBack } from './platformExit.ts';
import { createRouter } from './router.ts';

afterEach(() => vi.restoreAllMocks());

const tizenFake = () => {
  const exit = vi.fn();
  return { exit, g: { tizen: { application: { getCurrentApplication: () => ({ exit }) } } } };
};
const host = (kind: 'desktop' | 'androidtv') => {
  const exit = vi.fn();
  return { exit, g: { __IPTV_HOST__: { kind, protocol: 1, shellVersion: '0.1.0', exit } } };
};

describe('exitApp', () => {
  it('Tizen exits the current application', () => {
    const t = tizenFake();
    exitApp('tizen', t.g);
    expect(t.exit).toHaveBeenCalledOnce();
  });

  it('webOS calls platformBack and never closes the window', () => {
    const platformBack = vi.fn();
    const close = vi.fn();
    exitApp('webos', { webOS: { platformBack }, close } as never);
    expect(platformBack).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('webOS without platformBack logs and does nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => exitApp('webos', {})).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Exit failed', 'NoPlatformBack');
  });

  it('desktop and Android TV ask their native host to exit', () => {
    for (const kind of ['desktop', 'androidtv'] as const) {
      const h = host(kind);
      exitApp(kind, h.g);
      expect(h.exit).toHaveBeenCalledOnce();
    }
  });

  it('the browser does nothing, and a missing or throwing API never throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => exitApp('browser', {})).not.toThrow();
    expect(() => exitApp('tizen', {})).not.toThrow();
    expect(() => exitApp('webos', { webOS: { platformBack: () => { throw new TypeError('x'); } } })).not.toThrow();
    expect(error).toHaveBeenCalledWith('Exit failed', 'TypeError');
  });
});

describe('rootBack', () => {
  it('Tizen, desktop and hosted web show our dialog and do not leave by themselves', () => {
    for (const id of ['tizen', 'desktop', 'browser'] as const) {
      const t = tizenFake();
      expect(rootBack(profileFor(id).exitPolicy, id, false, t.g)).toBe('dialog');
      expect(t.exit).not.toHaveBeenCalled();
    }
  });

  it('webOS hands Back to the platform with no dialog of ours', () => {
    const platformBack = vi.fn();
    expect(rootBack(profileFor('webos').exitPolicy, 'webos', false, { webOS: { platformBack } })).toBe('left');
    expect(platformBack).toHaveBeenCalledOnce();
  });

  it('Android TV leaves at once', () => {
    const h = host('androidtv');
    expect(rootBack(profileFor('androidtv').exitPolicy, 'androidtv', false, h.g)).toBe('left');
    expect(h.exit).toHaveBeenCalledOnce();
  });

  it('a held Back (repeated keydown) is ignored everywhere: the app never handles a long press of Back', () => {
    const platformBack = vi.fn();
    expect(rootBack('dialog', 'tizen', true)).toBe('ignored');
    expect(rootBack('platformBack', 'webos', true, { webOS: { platformBack } })).toBe('ignored');
    expect(platformBack).not.toHaveBeenCalled();
  });
});

describe('Back during playback (Vidaa/Titan rule)', () => {
  it('Back from the full-screen player pops to the screen below; it never reaches the root exit', () => {
    const r = createRouter();
    r.reset('home');
    r.push('player', { channelId: 'demo-news' });
    expect(r.back()).toBe('screen');
    expect(r.current()?.screen).toBe('home');
  });
});
