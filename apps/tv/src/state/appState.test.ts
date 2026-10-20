import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InitState } from '@iptv/app-api';
import { DEFAULT_SETTINGS } from '@iptv/core';
import {
  INIT_TIMEOUT_MS, applyInitState, bootstrap, companionStatus, cooldown, cooldownOf, initFailed, initState, restoreWaitUntil, setRestoreWaitUntil,
  setStreamCooldown, settings, wireEvents,
} from './appState.ts';

const ready: InitState = {
  sources: [{ id: 's1', name: 'Mine', kind: 'xtream', active: true }],
  activeSourceId: 's1',
  groups: [],
  settings: DEFAULT_SETTINGS, hasVod: false,
};

function fakeRouter() {
  return { reset: vi.fn(), push: vi.fn() };
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
  it('pushes Start over Home when Open on is the Start page', async () => {
    const router = fakeRouter();
    await bootstrap({ init: () => Promise.resolve({ ...ready, settings: { ...DEFAULT_SETTINGS, openOn: 'start' } }) }, router);
    expect(router.reset).toHaveBeenCalledWith('home', {});
    expect(router.push).toHaveBeenCalledWith('start', {});
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

  it('a restored backup: toast, the restore wait ends, and the state (settings) is read again', async () => {
    const fns = new Map<string, (p: unknown) => void>();
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => undefined; };
    const toast = vi.fn();
    const init = vi.fn(async () => ({ sources: [], activeSourceId: undefined, groups: [], settings: { ...DEFAULT_SETTINGS, subtitleLanguage: 'sv' }, hasVod: false, cooldown: { state: 'clear' as const } }));
    setRestoreWaitUntil(Date.now() + 60_000);
    const off = wireEvents(on, toast, { api: { init }, router: { reset: vi.fn(), current: () => undefined } as never, playing: () => false, stopPlayback: vi.fn() });
    fns.get('backupRestored')?.({ type: 'backupRestored', origin: 'remote', applied: 3, pending: 0, sources: 1, at: 0 });
    expect(toast.mock.calls[0]?.[0]).toBe('Restored 3 changes from your backup.');
    expect(restoreWaitUntil()).toBeUndefined();
    await vi.waitFor(() => expect(settings()?.subtitleLanguage).toBe('sv'));
    off();
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

describe('wireEvents – refusal cooldown', () => {
  it("follows the active source's cooldown from InitState and events, without a toast", () => {
    const fns = new Map<string, (p: unknown) => void>();
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => undefined; };
    const toast = vi.fn();
    const off = wireEvents(on, toast);
    applyInitState({ sources: [], activeSourceId: 's1', groups: [], settings: DEFAULT_SETTINGS, hasVod: false, cooldown: { state: 'waiting', until: 9, reason: 'refused' } });
    expect(cooldown()).toEqual({ state: 'waiting', until: 9, reason: 'refused' });
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 'other', cooldown: { state: 'clear' } });
    expect(cooldown()).toEqual({ state: 'waiting', until: 9, reason: 'refused' });
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 's1', cooldown: { state: 'waiting', until: 5, reason: 'refused' } });
    expect(cooldown()).toEqual({ state: 'waiting', until: 5, reason: 'refused' });
    fns.get('refreshFailed')?.({ type: 'refreshFailed', what: 'playlist', sourceId: 's1', error: { name: 'SourceRefused', message: 'x' } });
    expect(toast).not.toHaveBeenCalled();
    applyInitState({ sources: [], groups: [], settings: DEFAULT_SETTINGS, hasVod: false });
    expect(cooldown()).toEqual({ state: 'clear' });
    // An event that arrived before InitState still counts once its source is active.
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 's9', cooldown: { state: 'waiting', until: 7, reason: 'refused' } });
    applyInitState({ sources: [], activeSourceId: 's9', groups: [], settings: DEFAULT_SETTINGS, hasVod: false, cooldown: { state: 'clear' } });
    expect(cooldown()).toEqual({ state: 'waiting', until: 7, reason: 'refused' });
    off();
  });

  it("a host's cooldown blocks only its streams, and shows for the current stream on that host", () => {
    const fns = new Map<string, (p: unknown) => void>();
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => undefined; };
    const off = wireEvents(on, vi.fn());
    applyInitState({ sources: [], activeSourceId: 'h1', groups: [], settings: DEFAULT_SETTINGS, hasVod: false, cooldown: { state: 'clear' } });
    const hostWait = { state: 'waiting', until: 50, reason: 'refused' } as const;
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 'h1', streamKey: 'h1@a.test', cooldown: hostWait });
    expect(cooldownOf('h1@a.test')).toEqual(hostWait);
    expect(cooldownOf('h1@b.test')).toEqual({ state: 'clear' });
    expect(cooldownOf(undefined)).toEqual({ state: 'clear' });
    expect(cooldown()).toEqual({ state: 'clear' }); // no stream on that host is current
    setStreamCooldown('h1@a.test');
    expect(cooldown()).toEqual(hostWait);
    setStreamCooldown('h1@b.test');
    expect(cooldown()).toEqual({ state: 'clear' });
    // The source's own cooldown blocks every stream; the longer wait shows.
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 'h1', cooldown: { state: 'waiting', until: 20, reason: 'unreachable' } });
    expect(cooldownOf('h1@b.test')).toEqual({ state: 'waiting', until: 20, reason: 'unreachable' });
    expect(cooldownOf('h1@a.test')).toEqual(hostWait);
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 'h1', cooldown: { state: 'clear' } });
    setStreamCooldown(undefined);
    off();
  });

  it("a playable's cooldown seeds its host until an event says otherwise", () => {
    const fns = new Map<string, (p: unknown) => void>();
    const on = (t: string, fn: (p: unknown) => void) => { fns.set(t, fn); return () => undefined; };
    const off = wireEvents(on, vi.fn());
    applyInitState({ sources: [], activeSourceId: 'h2', groups: [], settings: DEFAULT_SETTINGS, hasVod: false, cooldown: { state: 'clear' } });
    const seed = { state: 'waiting', until: 70, reason: 'refused' } as const;
    expect(cooldownOf('h2@a.test', seed)).toEqual(seed); // the gate decides with the seed before it is published
    setStreamCooldown('h2@a.test', seed);
    expect(cooldown()).toEqual(seed);
    fns.get('cooldown')?.({ type: 'cooldown', sourceId: 'h2', streamKey: 'h2@a.test', cooldown: { state: 'clear' } });
    expect(cooldown()).toEqual({ state: 'clear' });
    setStreamCooldown('h2@a.test', seed); // an older answer never overrides an event
    expect(cooldown()).toEqual({ state: 'clear' });
    expect(cooldownOf('h2@a.test', seed)).toEqual({ state: 'clear' });
    setStreamCooldown(undefined);
    off();
  });
});

describe('wireEvents – source changes from the phone', () => {
  const other: InitState = {
    sources: [{ id: 's1', name: 'Mine', kind: 'xtream', active: false }, { id: 's2', name: 'Other', kind: 'm3u', active: true }],
    activeSourceId: 's2',
    groups: [],
    settings: DEFAULT_SETTINGS, hasVod: false,
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
