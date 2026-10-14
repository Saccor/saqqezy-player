import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPhoneToTv, newQrSecrets, PROTOCOL_VERSION, SecureChannel, type FrameTransport, type PairingSecrets, type PhoneToTv,
  type TvToPhone, type WebSocketFactory,
} from '@iptv/companion-protocol';
import {
  CompanionClient, GETSTATE_BACKOFF_MS, isUnknownTvMessage, SOURCE_IDLE_TIMEOUT_MS, WELCOME_TIMEOUT_MS, type ClientHandlers,
  type StateStatus,
} from './client.ts';
import { emptyLayout } from '@iptv/core';
import { REQUEST_TIMEOUT_MS } from './pending.ts';

/** A controllable WebSocket; what the phone sends goes to `FakeWs.toTv`. */
class FakeWs extends EventTarget {
  static all: FakeWs[] = [];
  static toTv: ((f: Uint8Array) => void) | undefined;
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeWs.all.push(this);
  }
  send(d: Uint8Array): void {
    if (d.byteLength > 0) FakeWs.toTv?.(d.slice());
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    this.onopen?.({});
  }
  drop(code: number, reason = ''): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
    this.onclose?.({ code, reason });
  }
}

const last = () => FakeWs.all[FakeWs.all.length - 1]!;

/** setImmediate is left real by the fake timers: it lets real async work (WebCrypto) run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/** Waits (in real time, up to ~5 s) until `cond` holds; WebCrypto runs off the main thread. */
async function waitFor(cond: () => boolean, what = 'condition'): Promise<void> {
  const until = performance.now() + 5_000;
  while (!cond()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

/** Lets in-flight crypto and message handling finish: a short real-time pause. */
async function settle(ms = 30): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) await tick();
}

/** The TV end: a real SecureChannel (role tv) wired to the fake socket. */
function makeTv(secrets: PairingSecrets) {
  const listeners = new Set<(f: Uint8Array) => void>();
  const transport: FrameTransport = {
    send: (f) => {
      const ws = last();
      if (ws.readyState === 1) ws.onmessage?.({ data: f.slice().buffer });
    },
    onFrame: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close: () => {},
  };
  FakeWs.toTv = (f) => {
    for (const fn of listeners) fn(f);
  };
  const tv = new SecureChannel<TvToPhone, PhoneToTv>({ secrets, role: 'tv', transport, validate: isPhoneToTv });
  const received: { msg: PhoneToTv; msgId: number }[] = [];
  tv.onMessage((msg, msgId) => received.push({ msg, msgId }));
  const of = (t: PhoneToTv['t']) => received.filter((r) => r.msg.t === t);
  return { tv, received, of };
}

function makeHandlers() {
  const ev = { ended: [] as string[], status: [] as StateStatus[], states: 0, progress: 0, welcome: [] as number[] };
  const handlers: ClientHandlers = {
    welcome: (tv) => ev.welcome.push(tv.protocol),
    state: () => ev.states++,
    layout: () => {},
    progress: () => ev.progress++,
    link: () => {},
    stateStatus: (s) => ev.status.push(s),
    ended: (r) => ev.ended.push(r),
  };
  return { ev, handlers };
}

const STATE: TvToPhone = {
  t: 'state',
  state: {
    version: 1,
    sources: [],
    groups: [],
    channels: [],
    layout: emptyLayout(),
    coverageKnown: false,
  },
};

describe('CompanionClient', () => {
  let secrets: PairingSecrets;
  let client: CompanionClient | undefined;

  beforeEach(async () => {
    secrets = await newQrSecrets();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    FakeWs.all = [];
  });
  afterEach(() => {
    client?.close(false);
    client = undefined;
    FakeWs.toTv = undefined;
    vi.useRealTimers();
  });

  function start() {
    const { ev, handlers } = makeHandlers();
    const tv = makeTv(secrets);
    client = new CompanionClient(secrets, {
      relayUrl: 'ws://relay.example.test',
      client: { kind: 'phone', label: 'Test phone' },
      handlers,
      WebSocket: FakeWs as unknown as WebSocketFactory,
      isHidden: () => false,
    });
    client.start();
    return { ev, tv, c: client };
  }

  async function openAndWelcome(tv: ReturnType<typeof makeTv>, ev: ReturnType<typeof makeHandlers>['ev']) {
    last().open();
    await waitFor(() => tv.of('getState').length === 1, 'hello and getState at the TV');
    await tv.tv.send({ t: 'welcome', tv: { label: 'TV', appVersion: '1.0.0', protocol: PROTOCOL_VERSION } });
    await waitFor(() => ev.welcome.length === 1, 'welcome at the phone');
  }

  it('says hello with its protocol version and records the TV protocol from welcome', async () => {
    const { ev, tv, c } = start();
    await openAndWelcome(tv, ev);
    const hello = tv.of('hello')[0]?.msg;
    expect(hello).toEqual({ t: 'hello', client: { kind: 'phone', label: 'Test phone', protocol: PROTOCOL_VERSION } });
    expect(ev.welcome).toEqual([PROTOCOL_VERSION]);
    expect(c.tvProtocol).toBe(PROTOCOL_VERSION);
  });

  it('ends with no-welcome when the TV does not welcome it within WELCOME_TIMEOUT_MS of the socket opening', async () => {
    const { ev } = start();
    last().open();
    await settle();
    await vi.advanceTimersByTimeAsync(WELCOME_TIMEOUT_MS - 1);
    expect(ev.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ev.ended).toEqual(['no-welcome']);
  });

  it('maps final closes to end reasons: 4001 replaced, 4000 expired, and the TV bye', async () => {
    {
      const { ev, tv } = start();
      await openAndWelcome(tv, ev);
      last().drop(4001);
      await waitFor(() => ev.ended.length > 0);
      expect(ev.ended).toEqual(['replaced']);
    }
    {
      const { ev, tv } = start();
      await openAndWelcome(tv, ev);
      last().drop(4000);
      await waitFor(() => ev.ended.length > 0);
      expect(ev.ended).toEqual(['expired']);
    }
    {
      const { ev, tv } = start();
      await openAndWelcome(tv, ev);
      await tv.tv.send({ t: 'bye' });
      await waitFor(() => ev.ended.length > 0);
      expect(ev.ended).toEqual(['tv-bye']);
    }
  });

  it('asks again after Busy with the 2 s / 5 s / 10 s backoff, then reports the TV as not answering', async () => {
    const { ev, tv } = start();
    await openAndWelcome(tv, ev);
    const busy = async () => {
      const req = tv.of('getState').at(-1)!;
      await tv.tv.send({ t: 'result', requestMsgId: req.msgId, ok: false, error: { name: 'Busy', message: 'The TV is busy. Try again.' } });
      await settle(); // the phone decrypts the result and schedules its retry
    };
    await busy();
    for (const delay of GETSTATE_BACKOFF_MS) {
      const before = tv.of('getState').length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      await settle();
      expect(tv.of('getState').length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      await waitFor(() => tv.of('getState').length === before + 1, 'the retry');
      await busy();
    }
    await waitFor(() => ev.status.at(-1) === 'unanswered', 'unanswered');
    expect(tv.of('getState')).toHaveLength(4);
    // A state later on clears it.
    await tv.tv.send(STATE);
    await waitFor(() => ev.status.at(-1) === 'ok', 'ok');
  });

  it('retries getState after a timeout, at most 3 times, then reports the TV as not answering', async () => {
    const { ev, tv, c } = start();
    await openAndWelcome(tv, ev);
    expect(tv.of('getState')).toHaveLength(1);
    let n = 1;
    for (const delay of GETSTATE_BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + delay);
      n++;
      await waitFor(() => tv.of('getState').length === n, `getState #${n}`);
      await settle(); // the phone registers the new request's timeout
    }
    expect(tv.of('getState')).toHaveLength(4);
    expect(ev.status).not.toContain('unanswered');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await waitFor(() => ev.status.at(-1) === 'unanswered', 'unanswered');
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(tv.of('getState')).toHaveLength(4); // capped
    // Retry starts a fresh round.
    c.getState();
    await waitFor(() => tv.of('getState').length === 5, 'the Retry getState');
  });

  it('keeps a source request alive while progress arrives, and stalls it only after 60 s of silence', async () => {
    const { ev, tv, c } = start();
    await openAndWelcome(tv, ev);
    await tv.tv.send(STATE);
    await waitFor(() => ev.states === 1, 'the state');
    let stalls = 0;
    const done = c.request({ t: 'refresh', what: 'both' }, () => stalls++);
    done.catch(() => {});
    await waitFor(() => tv.of('refresh').length === 1, 'the refresh at the TV');
    await settle(); // the phone registers the request
    const req = tv.of('refresh')[0]!;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(SOURCE_IDLE_TIMEOUT_MS - 10_000);
      await tv.tv.send({ t: 'progress', phase: 'playlist', count: 100 * (i + 1) });
      await waitFor(() => ev.progress === i + 1, 'progress at the phone');
    }
    expect(stalls).toBe(0);
    await vi.advanceTimersByTimeAsync(SOURCE_IDLE_TIMEOUT_MS);
    expect(stalls).toBe(1);
    // After the stall the client asks for the state once, and a late result still settles the request.
    await waitFor(() => tv.of('getState').length === 2, 'getState after the stall');
    await tv.tv.send({ t: 'result', requestMsgId: req.msgId, ok: true });
    await expect(done).resolves.toMatchObject({ ok: true });
  });

  it('drops messages with an unknown t from a newer TV silently: they never close the session', async () => {
    const { ev, tv } = start();
    await openAndWelcome(tv, ev);
    // More than the 5-failure limit; each is an authentic message of a type this companion does not know.
    for (let i = 0; i < 8; i++) await tv.tv.send({ t: 'fromTheFuture', n: i } as unknown as TvToPhone);
    await tv.tv.send(STATE);
    await waitFor(() => ev.states === 1, 'the state after the unknown messages');
    expect(ev.ended).toEqual([]);
  });

  it('still counts a malformed message of a known t as a failure', async () => {
    const { ev, tv } = start();
    await openAndWelcome(tv, ev);
    for (let i = 0; i < 5; i++) await tv.tv.send({ t: 'progress', phase: 'nope', count: -1 } as unknown as TvToPhone);
    await waitFor(() => ev.ended.length > 0, 'the close');
    expect(ev.ended).toEqual(['peer-errors']);
  });
});

describe('isUnknownTvMessage', () => {
  it('is true only for a record whose t this companion does not know', () => {
    expect(isUnknownTvMessage({ t: 'fromTheFuture' })).toBe(true);
    expect(isUnknownTvMessage({ t: 'state' })).toBe(false); // known t, even if malformed
    expect(isUnknownTvMessage({ t: 'result', requestMsgId: 1, ok: true })).toBe(false);
    expect(isUnknownTvMessage({ t: 7 })).toBe(false);
    expect(isUnknownTvMessage({})).toBe(false);
    expect(isUnknownTvMessage(null)).toBe(false);
    expect(isUnknownTvMessage(['t'])).toBe(false);
  });
});
