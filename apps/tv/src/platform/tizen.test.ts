import { describe, expect, test } from 'vitest';
import { TIZEN_KEYS_TO_REGISTER } from '@iptv/platform';
import {
  AVPLAY_DISPLAY_SPACE, createAvplayStorePool, exit, getAvplayStorePlayer, isUnavailableAvplay, mountAvplayObject, readPanelCaps, registerKeys, setScreenSaver, type TizenLike,
} from './tizen.ts';

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
    expect(readPanelCaps(g as never)).toEqual({ uhd: true, eightK: false, hdrTv: true, avplayVersion: '6.0.1', answered: { uhd: true, hdrTv: true } });
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
  test('answered false is recorded as answered', () => {
    const g = { webapis: { productinfo: { isUdPanelSupported: () => false, is8KPanelSupported: () => false }, avinfo: { isHdrTvSupport: () => false } } };
    expect(readPanelCaps(g as never)).toEqual({ uhd: false, eightK: false, hdrTv: false, answered: { uhd: true, eightK: true, hdrTv: true } });
  });
});

describe('mountAvplayObject', () => {
  function fakeDom() {
    const made: { type?: string; style: Record<string, string> }[] = [];
    const children: unknown[] = [];
    const doc = {
      createElement: () => {
        const el = { style: {} as Record<string, string>, type: undefined as string | undefined, setAttribute(_k: string, v: string) { el.type = v; } };
        made.push(el);
        return el;
      },
      documentElement: { style: {} as Record<string, string> },
      body: { style: {} as Record<string, string> },
    };
    const root = {
      style: {} as Record<string, string>,
      appendChild: (c: unknown) => { children.push(c); },
      querySelector: (sel: string) => (sel === 'object[type="application/avplayer"]' ? children[0] ?? null : null),
    };
    return { doc: doc as unknown as Document, root: root as unknown as HTMLElement, made, children };
  }

  test('one object for the document: mounting again (slot 0 remade after multiview) reuses it', () => {
    const { doc, root, made, children } = fakeDom();
    const first = mountAvplayObject(root, doc);
    const again = mountAvplayObject(root, doc);
    expect(again).toBe(first);
    expect(made).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(made[0]!.type).toBe('application/avplayer');
  });
});

describe('getAvplayStorePlayer', () => {
  test('a new instance from webapis.avplaystore', () => {
    const inst = { open() {} };
    expect(getAvplayStorePlayer({ webapis: { avplaystore: { getPlayer: () => inst as never } } })).toBe(inst);
  });

  test('no store, or a refused instance (QUOTA_EXCEEDED_ERR): a player whose every open fails as not supported', () => {
    for (const g of [{}, { webapis: { avplaystore: { getPlayer: () => { throw Object.assign(new Error('max'), { name: 'QuotaExceededError' }); } } } }]) {
      const av = getAvplayStorePlayer(g);
      let thrown: unknown;
      try { av.open('http://example.test/a.ts'); } catch (e) { thrown = e; }
      expect((thrown as Error).name).toBe('NotSupportedError');
      expect(() => { av.stop(); av.close(); av.setDisplayRect(0, 0, 1, 1); }).not.toThrow();
      expect(av.getTotalTrackInfo()).toEqual([]);
      expect(isUnavailableAvplay(av)).toBe(true);
    }
    expect(isUnavailableAvplay(getAvplayStorePlayer({ webapis: { avplaystore: { getPlayer: () => ({ open() {} }) as never } } }))).toBe(false);
  });
});

describe('createAvplayStorePool', () => {
  test('a freed instance is reused: the store (4 at most, no release call) is asked only for new ones', () => {
    let made = 0;
    const g = { webapis: { avplaystore: { getPlayer: () => ({ id: ++made }) as never } } };
    const pool = createAvplayStorePool(g);
    const a = pool.take();
    pool.give(a);
    expect(pool.take()).toBe(a);
    const b = pool.take();
    expect(b).not.toBe(a);
    expect(made).toBe(2);
  });

  test('a stub that never played is not kept, so a later take asks the store again', () => {
    let ok = false;
    const inst = { id: 1 };
    const g = { webapis: { avplaystore: { getPlayer: () => { if (!ok) throw new Error('quota'); return inst as never; } } } };
    const pool = createAvplayStorePool(g);
    const stub = pool.take();
    pool.give(stub);
    ok = true;
    expect(pool.take()).toBe(inst);
  });
});
