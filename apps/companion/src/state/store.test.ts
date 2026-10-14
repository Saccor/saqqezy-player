import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingSecrets } from '@iptv/companion-protocol';

type Result = { t: 'result'; requestMsgId: number; ok: boolean };
interface FakeRequest { msg: { t: string }; onStall?: () => void; resolve: (r: Result) => void }

const ctl = vi.hoisted(() => ({ throwOnConstruct: false, requests: [] as FakeRequest[] }));

vi.mock('../connection/client.ts', () => ({
  CompanionClient: class {
    constructor() {
      if (ctl.throwOnConstruct) throw new Error('cannot start');
    }
    start(): void {}
    close(): void {}
    getState(): void {}
    resumeIfNeeded(): void {}
    request(msg: { t: string }, onStall?: () => void): Promise<Result> {
      return new Promise((resolve) => ctl.requests.push({ msg, onStall, resolve }));
    }
  },
}));

const { connect, store } = await import('./store.ts');
const { runRequest } = await import('./actions.ts');

const SECRETS = {} as PairingSecrets;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  ctl.throwOnConstruct = false;
  ctl.requests = [];
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
