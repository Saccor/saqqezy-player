import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InitState } from '@iptv/app-api';
import { DEFAULT_SETTINGS } from '@iptv/core';
import { INIT_TIMEOUT_MS, applyInitState, bootstrap, companionStatus, initFailed, initState, wireEvents } from './appState.ts';

const ready: InitState = {
  sources: [{ id: 's1', name: 'Mine', kind: 'xtream', active: true }],
  activeSourceId: 's1',
  groups: [],
  settings: DEFAULT_SETTINGS,
};

function fakeRouter() {
  return { reset: vi.fn() };
}

afterEach(() => { vi.useRealTimers(); });

describe('bootstrap', () => {
  it('routes to the initial screen when init succeeds', async () => {
    const router = fakeRouter();
    await bootstrap({ init: () => Promise.resolve(ready) }, router);
    expect(router.reset).toHaveBeenCalledWith('home', {});
    expect(initFailed()).toBe(false);
    expect(initState()).toEqual(ready);
  });

  it('does not route to Add source when init fails; it flags the load error instead', async () => {
    const router = fakeRouter();
    await bootstrap({ init: () => Promise.reject(new Error('db broken')) }, router);
    expect(router.reset).not.toHaveBeenCalled();
    expect(initFailed()).toBe(true);
  });

  it('times out after 10 s and flags the load error', async () => {
    vi.useFakeTimers();
    const router = fakeRouter();
    const done = bootstrap({ init: () => new Promise<InitState>(() => {}) }, router);
    expect(INIT_TIMEOUT_MS).toBe(10_000);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS - 1);
    expect(initFailed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(initFailed()).toBe(true);
    expect(router.reset).not.toHaveBeenCalled();
  });

  it('a retry clears the error and routes on success; a late answer from a timed-out attempt is ignored', async () => {
    vi.useFakeTimers();
    const router = fakeRouter();
    let lateResolve: ((s: InitState) => void) | undefined;
    const first = bootstrap({ init: () => new Promise<InitState>((r) => { lateResolve = r; }) }, router);
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    await first;
    expect(initFailed()).toBe(true);

    const retry = bootstrap({ init: () => new Promise<InitState>(() => {}) }, router);
    expect(initFailed()).toBe(false);
    lateResolve?.(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT_MS);
    await retry;

    await bootstrap({ init: () => Promise.resolve(ready) }, router);
    expect(initFailed()).toBe(false);
    expect(router.reset).toHaveBeenCalledTimes(1);
  });
});

describe('wireEvents', () => {
  it('toasts a remote layout change and unsubscribes everything', () => {
    const fns = new Map<string, (p: unknown) => void>();
    const offs: string[] = [];
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => { offs.push(t); }; };
    const toast = vi.fn();
    const off = wireEvents(on, toast);
    fns.get('layoutChanged')?.({ type: 'layoutChanged', version: 2, origin: 'remote' });
    fns.get('layoutChanged')?.({ type: 'layoutChanged', version: 3, origin: 'local' });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toBe('Updated from your phone');
    off();
    expect(offs).toContain('layoutChanged');
  });

  it('tracks the phone companion status without a toast', () => {
    const fns = new Map<string, (p: unknown) => void>();
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => undefined; };
    const toast = vi.fn();
    const off = wireEvents(on, toast);
    expect(companionStatus()).toEqual({ state: 'idle' });
    fns.get('companion')?.({ type: 'companion', status: { state: 'connected', peerLabel: 'Phone', expiresAt: 9 } });
    expect(companionStatus()).toEqual({ state: 'connected', peerLabel: 'Phone', expiresAt: 9 });
    fns.get('companion')?.({ type: 'companion', status: { state: 'expired' } });
    expect(companionStatus()).toEqual({ state: 'expired' });
    expect(toast).not.toHaveBeenCalled();
    off();
  });
});

describe('wireEvents – source changes from the phone', () => {
  const other: InitState = {
    sources: [{ id: 's1', name: 'Mine', kind: 'xtream', active: false }, { id: 's2', name: 'Other', kind: 'm3u', active: true }],
    activeSourceId: 's2',
    groups: [],
    settings: DEFAULT_SETTINGS,
  };
  const setup = (route: string, playing: boolean, answer: InitState) => {
    const fns = new Map<string, (p: unknown) => void>();
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => undefined; };
    const toast = vi.fn();
    const current = { screen: route, params: {} };
    const router = { reset: vi.fn(), current: vi.fn(() => current) };
    const api = { init: vi.fn(() => Promise.resolve(answer)) };
    const stopPlayback = vi.fn();
    wireEvents(on, toast, { api, router: router as never, playing: () => playing, stopPlayback });
    const fire = async (e: unknown) => { fns.get('sourcesChanged')?.(e); await new Promise((r) => setTimeout(r, 0)); };
    return { api, router, stopPlayback, toast, fire };
  };

  it('remote switch: toast, re-reads InitState, applies it and stops the old stream', async () => {
    applyInitState(ready);
    const t = setup('home', true, other);
    await t.fire({ type: 'sourcesChanged', activeSourceId: 's2', origin: 'remote' });
    expect(t.toast).toHaveBeenCalledWith('Updated from your phone', 0);
    expect(t.stopPlayback).toHaveBeenCalledTimes(1);
    expect(t.api.init).toHaveBeenCalledTimes(1);
    expect(initState()).toEqual(other);
    expect(t.router.reset).not.toHaveBeenCalled();
  });

  it('remote delete of the last source resets to Add source', async () => {
    applyInitState(ready);
    const t = setup('home', true, { ...ready, sources: [], groups: [] });
    await t.fire({ type: 'sourcesChanged', origin: 'remote' });
    expect(t.stopPlayback).toHaveBeenCalledTimes(1);
    expect(t.router.reset).toHaveBeenCalledWith('addSource', {});
  });

  it('a local change is not applied twice: no init, no stop, no toast', async () => {
    applyInitState(ready);
    const t = setup('settings', true, other);
    await t.fire({ type: 'sourcesChanged', activeSourceId: 's2', origin: 'local' });
    expect(t.api.init).not.toHaveBeenCalled();
    expect(t.stopPlayback).not.toHaveBeenCalled();
    expect(t.toast).not.toHaveBeenCalled();
    expect(initState()).toEqual(ready);
  });

  it('a failing init leaves the old state and does not throw', async () => {
    applyInitState(ready);
    const t = setup('home', false, other);
    t.api.init.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await t.fire({ type: 'sourcesChanged', activeSourceId: 's2', origin: 'remote' });
    expect(initState()).toEqual(ready);
    warn.mockRestore();
  });
});
