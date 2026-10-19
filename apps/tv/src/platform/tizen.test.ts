import { describe, expect, test } from 'vitest';
import { TIZEN_KEYS_TO_REGISTER } from '@iptv/platform';
import { AVPLAY_DISPLAY_SPACE, exit, readPanelCaps, registerKeys, setScreenSaver, type TizenLike } from './tizen.ts';

function fakeTizen(opts: { batch?: boolean; batchThrows?: boolean } = {}) {
  const calls: { batch: string[][]; single: string[]; exits: number } = { batch: [], single: [], exits: 0 };
  const t: TizenLike = {
    tvinputdevice: {
      registerKey: (k: string) => { calls.single.push(k); },
      ...(opts.batch === false ? {} : {
        registerKeyBatch: (keys: string[], ok?: () => void) => {
          if (opts.batchThrows) throw new Error('batch failed');
          calls.batch.push([...keys]);
          ok?.();
        },
      }),
    },
    application: { getCurrentApplication: () => ({ exit: () => { calls.exits++; } }) },
  };
  return { t, calls };
}

describe('tizen platform', () => {
  test('registerKeys registers the remote keys in one batch', () => {
    const { t, calls } = fakeTizen();
    expect(registerKeys({ tizen: t })).toBe(true);
    expect(calls.batch).toEqual([TIZEN_KEYS_TO_REGISTER]);
    expect(calls.single).toEqual([]);
  });

  test('falls back to one-by-one registration when the batch call is missing or throws', () => {
    for (const opts of [{ batch: false }, { batchThrows: true }]) {
      const { t, calls } = fakeTizen(opts);
      expect(registerKeys({ tizen: t })).toBe(true);
      expect(calls.single).toEqual(TIZEN_KEYS_TO_REGISTER);
    }
  });

  test('a key that fails to register does not stop the others', () => {
    const seen: string[] = [];
    const t: TizenLike = {
      tvinputdevice: { registerKey: (k) => { if (k === 'Info') throw new Error('no'); seen.push(k); } },
    };
    expect(registerKeys({ tizen: t })).toBe(true);
    expect(seen).toEqual(TIZEN_KEYS_TO_REGISTER.filter((k) => k !== 'Info'));
  });

  test('registerKeys outside Tizen is a no-op', () => {
    expect(registerKeys({})).toBe(false);
  });

  test('exit() exits the current application, and never throws', () => {
    const { t, calls } = fakeTizen();
    exit({ tizen: t });
    expect(calls.exits).toBe(1);
    expect(() => exit({})).not.toThrow();
    const broken: TizenLike = { application: { getCurrentApplication: () => { throw new Error('x'); } } };
    expect(() => exit({ tizen: broken })).not.toThrow();
  });

  test('AVPlay display coordinates are the 1920x1080 design space', () => {
    expect(AVPLAY_DISPLAY_SPACE).toEqual({ w: 1920, h: 1080 });
  });
});

describe('setScreenSaver', () => {
  const ac = (fn: (s: unknown) => void) => ({ webapis: { appcommon: {
    AppCommonScreenSaverState: { SCREEN_SAVER_OFF: 0, SCREEN_SAVER_ON: 1 }, setScreenSaver: fn,
  } } });
  test('maps on/off to AppCommon states', () => {
    const got: unknown[] = [];
    const g = ac((s) => { got.push(s); });
    expect(setScreenSaver('off', g)).toBe(true);
    expect(setScreenSaver('on', g)).toBe(true);
    expect(got).toEqual([0, 1]);
  });
  test('false without appcommon, and when the call throws', () => {
    expect(setScreenSaver('off', {})).toBe(false);
    expect(setScreenSaver('off', ac(() => { throw new Error('x'); }))).toBe(false);
  });
});

describe('readPanelCaps', () => {
  test('reads each API, guarded', () => {
    const g = { webapis: {
      productinfo: { isUdPanelSupported: () => true, is8KPanelSupported: () => { throw new Error('x'); } },
      avinfo: { isHdrTvSupport: () => true },
      avplay: { getVersion: () => '6.0.1' },
    } };
    expect(readPanelCaps(g as never)).toEqual({ uhd: true, eightK: false, hdrTv: true, avplayVersion: '6.0.1' });
  });
  test('nothing available → all false', () => {
    expect(readPanelCaps({})).toEqual({ uhd: false, eightK: false, hdrTv: false });
  });
  test('a monitor whose APIs are missing, throw or return non-booleans falls back to FHD', () => {
    const g = { webapis: {
      productinfo: { isUdPanelSupported: () => { throw new Error('nope'); } },
      avinfo: { isHdrTvSupport: () => 'yes' },
      avplay: { getVersion: () => { throw new Error('v'); } },
    } };
    expect(readPanelCaps(g as never)).toEqual({ uhd: false, eightK: false, hdrTv: false });
    expect(readPanelCaps({ webapis: { productinfo: {}, avinfo: {}, avplay: {} } } as never)).toEqual({ uhd: false, eightK: false, hdrTv: false });
    expect(readPanelCaps({ webapis: { productinfo: null } } as never)).toEqual({ uhd: false, eightK: false, hdrTv: false });
  });
});
