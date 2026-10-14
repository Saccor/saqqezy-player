import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InitState } from '@iptv/app-api';
import { DEFAULT_SETTINGS } from '@iptv/core';
import { INIT_TIMEOUT_MS, bootstrap, initFailed, initState } from './appState.ts';

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
