import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingSecrets } from '@iptv/companion-protocol';

type Result = { t: 'result'; requestMsgId: number; ok: boolean };
interface FakeRequest { msg: { t: string }; onStall?: () => void; resolve: (r: Result) => void }

const ctl = vi.hoisted(() => ({
  throwOnConstruct: false,
  requests: [] as FakeRequest[],
  // The handlers the store passed to the client (state, layout, ...), called directly by the tests.
  handlers: undefined as any,
  getStateCalls: 0,
}));

vi.mock('../connection/client.ts', () => ({
  CompanionClient: class {
    constructor(_secrets: unknown, opts: { handlers: unknown }) {
      if (ctl.throwOnConstruct) throw new Error('cannot start');
      ctl.handlers = opts.handlers;
    }
    start(): void {}
    close(): void {}
    getState(): void {
      ctl.getStateCalls++;
    }
    resumeIfNeeded(): void {}
    request(msg: { t: string }, onStall?: () => void): Promise<Result> {
      return new Promise((resolve) => ctl.requests.push({ msg, onStall, resolve }));
    }
  },
}));

const { connect, store } = await import('./store.ts');
const { emptyLayout } = await import('@iptv/core');
const { runRequest } = await import('./actions.ts');

const SECRETS = {} as PairingSecrets;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  ctl.throwOnConstruct = false;
  ctl.requests = [];
  ctl.getStateCalls = 0;
});

describe('connect', () => {
  it('goes back to the pair phase when the client cannot be constructed, and rethrows for the caller to show', () => {
    ctl.throwOnConstruct = true;
    expect(() => connect(SECRETS)).toThrow('cannot start');
    expect(store.phase).toBe('pair');
  });
});

describe('runRequest working marker', () => {
  it('a stale request finishing does not clear (or stall) the marker of a newer request for the same source', async () => {
    connect(SECRETS);
    const first = runRequest({ t: 'refresh', what: 'both' }, { key: 's1' });
    const second = runRequest({ t: 'setActiveSource', id: 's1' }, { key: 's1' });
    expect(store.working['s1']?.op).toBe('setActive');
    ctl.requests[0]!.onStall?.(); // the old request stalls: the newer marker is not touched
    expect(store.working['s1']).toMatchObject({ op: 'setActive', stalled: false });
    ctl.requests[0]!.resolve({ t: 'result', requestMsgId: 1, ok: true });
    await first;
    await flush();
    expect(store.working['s1']?.op).toBe('setActive');
    ctl.requests[1]!.resolve({ t: 'result', requestMsgId: 2, ok: true });
    await second;
    expect(store.working['s1']).toBeUndefined();
  });
});

describe('state from another source', () => {
  // Layout versions count per source: a source switch can bring a lower version that is still the newer state.
  const stateOf = (activeSourceId: string, version: number) => ({
    version, activeSourceId, sources: [], groups: [], channels: [], coverageKnown: false,
    layout: { ...emptyLayout(), version },
  });

  it('accepts a state for a different active source even when its layout version is lower', () => {
    connect(SECRETS);
    ctl.handlers.state(stateOf('s1', 29));
    ctl.handlers.state(stateOf('s2', 3));
    expect(store.state?.activeSourceId).toBe('s2');
    expect(store.state?.layout.version).toBe(3);
    // Same source, older layout: still ignored (a newer layoutChanged overtook it).
    ctl.handlers.state(stateOf('s2', 2));
    expect(store.state?.layout.version).toBe(3);
  });

  it('asks for the state again when a layoutChanged is older than the held layout (the TV may have switched source)', () => {
    connect(SECRETS);
    ctl.handlers.state(stateOf('s1', 29));
    ctl.handlers.layout(4, { ...emptyLayout(), version: 4 }, 's1');
    expect(store.state?.layout.version).toBe(29);
    expect(ctl.getStateCalls).toBe(1);
  });

  it('ignores a layoutChanged for another source, even a newer one, and asks for the state', () => {
    connect(SECRETS);
    ctl.handlers.state(stateOf('s1', 3));
    ctl.handlers.layout(40, { ...emptyLayout(), version: 40, hideNoEpg: true }, 's2');
    expect(store.state?.layout.version).toBe(3);
    expect(store.state?.layout.hideNoEpg).toBe(false);
    expect(ctl.getStateCalls).toBe(1);
    // The same source's newer layout is applied.
    ctl.handlers.layout(4, { ...emptyLayout(), version: 4, hideNoEpg: true }, 's1');
    expect(store.state?.layout.version).toBe(4);
    expect(ctl.getStateCalls).toBe(1);
  });

  it('sends ops with the held state\'s active source id', async () => {
    connect(SECRETS);
    ctl.handlers.state(stateOf('s7', 1));
    const { sendOps } = await import('./actions.ts');
    void sendOps([{ op: 'setHideNoEpg', value: true }]);
    await flush();
    expect(ctl.requests.at(-1)!.msg).toMatchObject({ t: 'ops', sourceId: 's7', baseVersion: 1 });
  });
});
