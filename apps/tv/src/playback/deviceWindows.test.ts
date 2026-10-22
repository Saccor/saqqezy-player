import { describe, expect, test } from 'vitest';
import { createDeviceWindows, deviceWindowsLine } from './deviceWindows.ts';

function memStore() {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  return { m, store: () => s as unknown as Storage };
}

describe('createDeviceWindows', () => {
  test('the platform ceiling until the TV refuses a second picture; then 1, remembered', () => {
    const { store } = memStore();
    const d = createDeviceWindows(2, store);
    expect(d.max()).toBe(2);
    expect(d.refusal()).toBeUndefined();
    expect(d.refuse('subScaler', 1000)).toBe(true);
    expect(d.max()).toBe(1);
    expect(d.refuse('audioStream', 2000)).toBe(false);
    expect(d.refusal()).toEqual({ why: 'subScaler', at: 1000 });
    const again = createDeviceWindows(2, store);
    expect(again.max()).toBe(1);
    expect(again.refusal()).toEqual({ why: 'subScaler', at: 1000 });
  });

  test('Test again forgets it', () => {
    const { store, m } = memStore();
    const d = createDeviceWindows(2, store);
    d.refuse('noInstance', 5);
    d.reset();
    expect(d.max()).toBe(2);
    expect(m.size).toBe(0);
    expect(createDeviceWindows(2, store).max()).toBe(2);
  });

  test('a single-window platform never records anything', () => {
    const { store, m } = memStore();
    const d = createDeviceWindows(1, store);
    expect(d.refuse('subScaler', 1)).toBe(false);
    expect(m.size).toBe(0);
  });

  test('junk or missing storage reads as no refusal; a throwing store never throws', () => {
    const { store, m } = memStore();
    m.set('iptv.multiviewDevice', '{"why":"nope"}');
    expect(createDeviceWindows(2, store).max()).toBe(2);
    const broken = () => { throw new Error('denied'); };
    const d = createDeviceWindows(2, broken as never);
    expect(d.refuse('subScaler', 1)).toBe(true);
    expect(d.max()).toBe(1);
    expect(() => d.reset()).not.toThrow();
    expect(createDeviceWindows(2, () => undefined).max()).toBe(2);
  });
});

describe('deviceWindowsLine (Diagnostics)', () => {
  test('the ceiling and, after a refusal, why', () => {
    expect(deviceWindowsLine(6, undefined)).toBe('Up to 6 windows');
    expect(deviceWindowsLine(1, undefined)).toBe('Not on this device');
    expect(deviceWindowsLine(1, { why: 'subScaler', at: 0 })).toBe('1 window: this TV refused a second picture');
    expect(deviceWindowsLine(1, { why: 'noInstance', at: 0 })).toBe('1 window: this TV had no second player free');
    expect(deviceWindowsLine(1, { why: 'audioStream', at: 0 })).toBe('1 window: this TV cannot move the sound between windows');
  });
});
