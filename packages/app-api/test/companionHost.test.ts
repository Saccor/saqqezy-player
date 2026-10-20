import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SourceService, type LayoutOp } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { startFakeXtream } from '@iptv/fake-xtream';
import {
  isTvToPhone, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, newPairingCode, SecureChannel, secretsFromCode, secretsFromQrFragment,
  type CompanionState, type TvHeaderSupport, type FrameTransport, type PairingSecrets, type PhoneToTv, type TvToPhone,
} from '@iptv/companion-protocol';
import { AppApi } from '../src/appApi.ts';
import {
  BUSY_ERROR, CompanionHost, fitCompanionState, LOGO_MAX_CHARS, PAIRED_TTL_MS, PEER_TIMEOUT_MS, STATE_BUDGET_BYTES,
  UNPAIRED_TTL_MS, type CompanionStatus,
} from '../src/companionHost.ts';
import type { AppEvent } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 13, 18, 10);
const ORIGIN = 'https://manage.example.test';
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: 40, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const live: { api: AppApi; host: CompanionHost }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const l of live.splice(0)) {
    l.host.stop();
    await l.api.idle();
  }
});

let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); });

interface TestTransport extends FrameTransport {
  closed: boolean;
  fits?: (frameBytes: readonly number[]) => boolean;
  peer?: TestTransport;
  listeners: Set<(f: Uint8Array) => void>;
  closeListeners: Set<(reason: string) => void>;
  reconnected: Set<() => void>;
  disconnected: Set<() => void>;
  onClose(fn: (reason: string) => void): () => void;
  onReconnected(fn: () => void): () => void;
  onDisconnected(fn: () => void): () => void;
  /** Simulates the relay giving up on this transport. */
  finalClose(reason: string): void;
}

/** Two in-memory transports wired to each other; delivery is asynchronous like a socket. */
function transportPair(): [TestTransport, TestTransport] {
  const make = (): TestTransport => {
    const t: TestTransport = {
      closed: false,
      listeners: new Set(),
      closeListeners: new Set(),
      reconnected: new Set(),
      disconnected: new Set(),
      send(frame) {
        if (t.closed) throw new Error('closed');
        const peer = t.peer;
        if (peer) setTimeout(() => { if (!peer.closed) for (const fn of [...peer.listeners]) fn(frame); }, 0);
      },
      onFrame(fn) { t.listeners.add(fn); return () => t.listeners.delete(fn); },
      onClose(fn) { t.closeListeners.add(fn); return () => t.closeListeners.delete(fn); },
      onReconnected(fn) { t.reconnected.add(fn); return () => t.reconnected.delete(fn); },
      onDisconnected(fn) { t.disconnected.add(fn); return () => t.disconnected.delete(fn); },
      close() { t.closed = true; },
      finalClose(reason) {
        t.closed = true;
        for (const fn of [...t.closeListeners]) fn(reason);
      },
    };
    return t;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const xt = (username = 'test', password = 'test') =>
  ({ kind: 'xtream' as const, name: 'Fake', server: server.url, username, password });
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await settle(5);
  }
}

/** The phone end: a SecureChannel plus an inbox. */
function phone(secrets: PairingSecrets, transport: FrameTransport) {
  const ch = new SecureChannel<PhoneToTv, TvToPhone>({ secrets, role: 'phone', transport, validate: isTvToPhone });
  const inbox: TvToPhone[] = [];
  ch.onMessage((m) => inbox.push(m));
  const next = async <T extends TvToPhone['t']>(t: T, pred: (m: Extract<TvToPhone, { t: T }>) => boolean = () => true) => {
    let found: Extract<TvToPhone, { t: T }> | undefined;
    await until(() => {
      const i = inbox.findIndex((m) => m.t === t && pred(m as Extract<TvToPhone, { t: T }>));
      if (i < 0) return false;
      found = inbox.splice(i, 1)[0] as Extract<TvToPhone, { t: T }>;
      return true;
    });
    return found!;
  };
  /** Sends and waits for the `result` answering it. */
  const call = async (msg: PhoneToTv) => {
    const id = await ch.send(msg);
    return next('result', (r) => r.requestMsgId === id);
  };
  return { ch, inbox, next, call };
}

/** Fake setTimeout only, advancing with real time too, so socket-like delivery and crypto keep working. */
function fakeTimers() {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
}

function setup(opts: { unpairedTtlMs?: number; pairedTtlMs?: number; now?: () => number; headerSupport?: TvHeaderSupport } = {}) {
  const events: AppEvent[] = [];
  const statuses: CompanionStatus[] = [];
  const transports: { tv: TestTransport; phone: TestTransport; id: string; deadline: number | undefined }[] = [];
  let host!: CompanionHost;
  const service = new SourceService({ storage, fetch: (u, i) => fetch(u, i), now: () => NOW });
  const api = new AppApi({
    service, storage, emit: (e) => events.push(e), now: () => NOW, appVersion: '1.2.3',
    companion: (a, onStatus) => {
      host = new CompanionHost({
        api: a,
        tvLabel: 'Living room',
        appVersion: '1.2.3',
        companionOrigin: ORIGIN,
        onStatus: (s) => { statuses.push(s); onStatus(s); },
        openTransport: (id, o) => {
          const [tv, ph] = transportPair();
          transports.push({ tv, phone: ph, id, deadline: o?.deadline });
          return tv;
        },
        ...(opts.unpairedTtlMs !== undefined ? { unpairedTtlMs: opts.unpairedTtlMs } : {}),
        ...(opts.pairedTtlMs !== undefined ? { pairedTtlMs: opts.pairedTtlMs } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.headerSupport !== undefined ? { headerSupport: opts.headerSupport } : {}),
      });
      return host;
    },
  });
  live.push({ api, host });
  return { api, host, events, statuses, transports };
}

async function pairQr(s: ReturnType<typeof setup>) {
  const started = await s.host.start('qr');
  const fragment = started.qrUrl!.slice(started.qrUrl!.indexOf('#'));
  const secrets = await secretsFromQrFragment(fragment);
  const t = s.transports[s.transports.length - 1]!;
  expect(t.id).toBe(secrets.sessionIdB64);
  const p = phone(secrets, t.phone);
  return { started, p, t };
}

async function hello(p: ReturnType<typeof phone>, protocol = 1) {
  await p.ch.send({ t: 'hello', client: { kind: 'phone', label: 'My phone', protocol } });
  return p.next('welcome');
}

describe('CompanionHost', () => {
  test('QR session: welcome, state, ops create a list, layoutChanged, and the TV sees the list', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const before = Date.now();
    const { started, p, t } = await pairQr(s);
    expect(started.qrUrl!.startsWith(`${ORIGIN}/#s=`)).toBe(true);
    expect(started.code).toBeUndefined();
    expect(started.expiresAt).toBeGreaterThanOrEqual(before + UNPAIRED_TTL_MS);
    expect(started.expiresAt).toBeLessThanOrEqual(Date.now() + UNPAIRED_TTL_MS);
    expect(t.deadline).toBeGreaterThanOrEqual(before + PAIRED_TTL_MS);
    expect(s.host.status()).toEqual({ state: 'waiting', expiresAt: started.expiresAt });

    const welcome = await hello(p);
    expect(welcome.tv).toEqual({ label: 'Living room', appVersion: '1.2.3', protocol: PROTOCOL_VERSION });
    expect(s.host.status().state).toBe('connected');
    expect(s.host.status().peerLabel).toBe('My phone');
    // Paired: the session now lives up to 60 minutes from its start.
    expect(s.host.status().expiresAt).toBe(started.expiresAt - UNPAIRED_TTL_MS + PAIRED_TTL_MS);

    await p.ch.send({ t: 'getState' });
    const { state } = await p.next('state');
    expect(state.channels).toHaveLength(40);
    expect(state.sources).toHaveLength(1);

    const channelIds = state.channels.slice(0, 3).map((c) => c.id);
    const ops: LayoutOp[] = [
      { op: 'createList', id: 'l1', name: 'Evening' },
      { op: 'addToList', listId: 'l1', channelIds },
    ];
    const res = await p.call({ t: 'ops', sourceId: state.activeSourceId!, baseVersion: state.version, ops });
    expect(res.ok).toBe(true);
    const changed = await p.next('layoutChanged', (m) => m.layout.lists.some((l) => l.id === 'l1'));
    expect(changed.sourceId).toBe(state.activeSourceId);
    expect(changed.layout.lists.find((l) => l.id === 'l1')!.channelIds).toEqual(channelIds);
    expect(changed.version).toBe(changed.layout.version);
    expect((await s.api.getGroups()).some((g) => g.name === 'Evening')).toBe(true);
    expect(s.events.some((e) => e.type === 'layoutChanged' && e.origin === 'remote')).toBe(true);
  });

  test('a local layout change is pushed to the phone', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    const first = (await s.api.getChannelSlice('all', 0, 1)).rows[0]!;
    await s.api.toggleFavourite(first.id);
    const m = await p.next('layoutChanged');
    expect(m.layout.lists[0]!.channelIds).toContain(first.id);
  });

  test('ops for a source that is no longer active are rejected with WrongSource', async () => {
    const s = setup();
    const { sourceId: a } = await s.api.addSource(xt());
    const { sourceId: b } = await s.api.addSource({ ...xt(), name: 'Second' });
    const { p } = await pairQr(s);
    await hello(p);
    await s.api.setActiveSource(b);
    const before = await s.api.getLayout();
    const res = await p.call({ t: 'ops', sourceId: a, baseVersion: 0, ops: [{ op: 'setHideNoEpg', value: true }] });
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({ name: 'WrongSource', message: 'The TV switched to another source.' });
    expect(await s.api.getLayout()).toEqual(before);
    const ok = await p.call({ t: 'ops', sourceId: b, baseVersion: 0, ops: [{ op: 'setHideNoEpg', value: true }] });
    expect(ok.ok).toBe(true);
    expect((await p.next('layoutChanged')).sourceId).toBe(b);
  });

  test('a zap (markWatched) is not pushed to the companion; other layout changes are', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    const first = (await s.api.getChannelSlice('all', 0, 1)).rows[0]!;
    await s.api.markWatched(first.id, 'all');
    await s.api.markWatched(first.id, 'all');
    await settle(100);
    expect(p.inbox.some((m) => m.t === 'layoutChanged')).toBe(false);
    await s.api.toggleFavourite(first.id);
    const m = await p.next('layoutChanged');
    expect(m.layout.lists[0]!.channelIds).toContain(first.id);
    // The pushed layout still includes the zaps: only the push was skipped.
    expect(m.layout.recent).toEqual([first.id]);
  });

  test('a source switch, a new source or a playlist change on the TV pushes one coalesced state', async () => {
    const s = setup();
    const { sourceId: a } = await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    await settle(400);
    p.inbox.length = 0;
    const spy = vi.spyOn(s.api, 'getCompanionState');

    const { sourceId: b } = await s.api.addSource({ ...xt(), name: 'Second' });
    const added = await p.next('state');
    expect(added.state.sources.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(added.state.activeSourceId).toBe(a);

    // Switching runs setActiveSource, a fresh index and a background refresh: several changes, one push each burst.
    await s.api.setActiveSource(b);
    const switched = await p.next('state', (m) => m.state.activeSourceId === b);
    expect(switched.state.sources.find((x) => x.active)!.id).toBe(b);
    await s.api.idle();
    await settle(400);
    const extra = p.inbox.filter((m) => m.t === 'state').length;
    expect(extra).toBeLessThanOrEqual(2);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);

    // The pushed state counts as received: haveVersion with nothing changed gets stateUnchanged.
    p.inbox.length = 0;
    await p.ch.send({ t: 'getState', haveVersion: (await s.api.getLayout()).version });
    await p.next('stateUnchanged');
  });

  test('changing only Your countries pushes a fresh state with the new regions', async () => {
    const s = setup();
    await s.api.addSource(xt());
    await s.api.idle();
    const { p } = await pairQr(s);
    await hello(p, PROTOCOL_VERSION);
    await settle(400);
    p.inbox.length = 0;
    const version = (await s.api.getLayout()).version;
    await s.api.setRegions({ codes: ['SE', 'DK'], mode: 'first' });
    const pushed = await p.next('state', (m) => m.state.regions?.mode === 'first');
    expect(pushed.state.regions).toMatchObject({ mode: 'first', codes: ['SE', 'DK'] });
    expect(pushed.state.version).toBe(version);
    await s.api.setRegions({ codes: ['FI'], mode: 'only' });
    const again = await p.next('state', (m) => m.state.regions?.mode === 'only');
    expect(again.state.regions).toMatchObject({ mode: 'only', codes: ['FI'] });
  });

  test('no state is pushed while no companion is connected', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await s.api.addSource({ ...xt(), name: 'Second' });
    await settle(400);
    expect(p.inbox.some((m) => m.t === 'state')).toBe(false);
  });

  test('state never carries credentials; getSource does, and only it', async () => {
    const s = setup();
    // The fake server accepts only test/test, so look for the credential fields and the server address.
    const { sourceId } = await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    await p.ch.send({ t: 'getState' });
    const text = JSON.stringify(await p.next('state'));
    expect(text).not.toContain('"username"');
    expect(text).not.toContain('"password"');
    expect(text).not.toContain('"server"');
    expect(text).not.toContain(server.url);
    await p.ch.send({ t: 'getSource', id: sourceId });
    const { source } = await p.next('source');
    expect(source).toMatchObject({ id: sourceId, kind: 'xtream', server: server.url, username: 'test', password: 'test' });
    const missing = await p.call({ t: 'getSource', id: 'nope' });
    expect(missing.ok).toBe(false);
  });

  test('a source User-Agent and Referer never reach the phone, and a phone edit keeps them', async () => {
    const s = setup();
    const { sourceId } = await s.api.addSource(xt());
    await s.api.updateSource({ ...(await s.api.getSource(sourceId))!, userAgent: 'SyntheticAgent/1.0', referrer: 'http://example.test/' });
    const { p } = await pairQr(s);
    await hello(p);
    await p.ch.send({ t: 'getSource', id: sourceId });
    const text = JSON.stringify(await p.next('source'));
    expect(text).not.toContain('SyntheticAgent');
    expect(text).not.toContain('referrer');
    const res = await p.call({ t: 'updateSource', source: { ...xt(), id: sourceId, name: 'Renamed' } });
    expect(res).toMatchObject({ ok: true });
    expect(await s.api.getSource(sourceId)).toMatchObject({ name: 'Renamed', userAgent: 'SyntheticAgent/1.0', referrer: 'http://example.test/' });
  });

  test('a phone edit keeps the manual catch-up time of the source (the phone has no such field)', async () => {
    const s = setup();
    const { sourceId } = await s.api.addSource(xt());
    await s.api.setCatchupOffset(sourceId, -90);
    const { p } = await pairQr(s);
    await hello(p, 2);
    expect(await p.call({ t: 'updateSource', source: { ...xt(), id: sourceId, name: 'Renamed' } })).toMatchObject({ ok: true });
    expect(await s.api.getSource(sourceId)).toMatchObject({ name: 'Renamed', catchupOffsetMin: -90 });
  });

  test('protocol 2: welcome carries the TV header support', async () => {
    const headerSupport = { lists: { userAgent: false, referrer: false }, streams: { userAgent: true, referrer: false } };
    const s = setup({ headerSupport });
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    const welcome = await hello(p, 2);
    expect(welcome.tv).toEqual({ label: 'Living room', appVersion: '1.2.3', protocol: PROTOCOL_VERSION, headers: headerSupport });
  });

  test('protocol 2: getSource returns the stored User-Agent and Referer to a v2 phone', async () => {
    const s = setup();
    const { sourceId } = await s.api.addSource(xt());
    await s.api.updateSource({ ...(await s.api.getSource(sourceId))!, userAgent: 'SyntheticAgent/1.0', referrer: 'http://example.test/' });
    const { p } = await pairQr(s);
    await hello(p, 2);
    await p.ch.send({ t: 'getSource', id: sourceId });
    const { source } = await p.next('source');
    expect(source).toMatchObject({ userAgent: 'SyntheticAgent/1.0', referrer: 'http://example.test/' });
  });

  test('protocol 2 updateSource: an absent field keeps, "" clears, a value sets (cleaned)', async () => {
    const s = setup();
    const { sourceId } = await s.api.addSource(xt());
    await s.api.updateSource({ ...(await s.api.getSource(sourceId))!, userAgent: 'Old/1.0', referrer: 'http://old.example.test/' });
    const { p } = await pairQr(s);
    await hello(p, 2);
    expect(await p.call({ t: 'updateSource', source: { ...xt(), id: sourceId, userAgent: '  New/2.0 ' } })).toMatchObject({ ok: true });
    expect(await s.api.getSource(sourceId)).toMatchObject({ userAgent: 'New/2.0', referrer: 'http://old.example.test/' });
    expect(await p.call({ t: 'updateSource', source: { ...xt(), id: sourceId, referrer: '' } })).toMatchObject({ ok: true });
    const after = await s.api.getSource(sourceId);
    expect(after).toMatchObject({ userAgent: 'New/2.0' });
    expect(after && 'referrer' in after).toBe(false);
  });

  test('protocol 2 addSource stores the User-Agent and Referer', async () => {
    const s = setup();
    const { p } = await pairQr(s);
    await hello(p, 2);
    const res = await p.call({ t: 'addSource', input: { ...xt(), userAgent: 'SyntheticAgent/1.0', referrer: '' } });
    expect(res).toMatchObject({ ok: true });
    const [summary] = await s.api.listSources();
    const src = await s.api.getSource(summary!.id);
    expect(src).toMatchObject({ userAgent: 'SyntheticAgent/1.0' });
    expect(src && 'referrer' in src).toBe(false);
  });

  test('addSource through the companion forwards progress and adds the source', async () => {
    const s = setup();
    const { p } = await pairQr(s);
    await hello(p);
    const res = await p.call({ t: 'addSource', input: xt() });
    expect(res).toMatchObject({ ok: true });
    expect(p.inbox.some((m) => m.t === 'progress' && m.phase === 'playlist')).toBe(true);
    expect(await s.api.listSources()).toHaveLength(1);
  });

  test('addSource / updateSource go through the on-TV form rules (http/https only)', async () => {
    const s = setup();
    const { sourceId } = await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    // A bare host passes the wire check but not the TV form rule.
    const bare = await p.call({ t: 'addSource', input: { ...xt(), server: 'host.example.test:8080' } });
    expect(bare.ok).toBe(false);
    expect(bare.error!.name).toBe('ValidationError');
    expect(bare.error!.message).not.toContain('host.example.test');
    const blankUser = await p.call({ t: 'updateSource', source: { ...xt(), id: sourceId, username: '   ' } });
    expect(blankUser.ok).toBe(false);
    expect(await s.api.listSources()).toHaveLength(1);
    expect((await s.api.getSource(sourceId))!.kind === 'xtream' && (await s.api.getSource(sourceId) as { username: string }).username)
      .toBe('test');
  });

  test('errors in result are the scrubbed AppApi errors', async () => {
    const s = setup();
    const { p } = await pairQr(s);
    await hello(p);
    const res = await p.call({ t: 'addSource', input: xt('wrong', 'creds') });
    expect(res.ok).toBe(false);
    expect(res.error!.name).toBe('SourceAuthError');
    expect(JSON.stringify(res)).not.toContain('creds');
    expect(JSON.stringify(res)).not.toContain(server.url);
  });

  test('deleteSource, setActiveSource and refresh answer with result', async () => {
    const s = setup();
    const a = await s.api.addSource(xt());
    const b = await s.api.addSource({ ...xt(), name: 'Second' });
    const { p } = await pairQr(s);
    await hello(p);
    s.events.length = 0;
    expect((await p.call({ t: 'setActiveSource', id: b.sourceId })).ok).toBe(true);
    expect((await s.api.listSources()).find((x) => x.active)!.id).toBe(b.sourceId);
    // The TV UI follows: the event names the phone as the origin.
    expect(s.events.filter((e) => e.type === 'sourcesChanged')).toEqual([
      { type: 'sourcesChanged', activeSourceId: b.sourceId, origin: 'remote' },
    ]);
    expect((await p.call({ t: 'refresh', what: 'playlist' })).ok).toBe(true);
    s.events.length = 0;
    expect((await p.call({ t: 'deleteSource', id: a.sourceId })).ok).toBe(true);
    expect(await s.api.listSources()).toHaveLength(1);
    expect(s.events.filter((e) => e.type === 'sourcesChanged')).toEqual([
      { type: 'sourcesChanged', activeSourceId: b.sourceId, origin: 'remote' },
    ]);
  });

  test('code mode pairs with the displayed code', async () => {
    const s = setup();
    const started = await s.host.start('code');
    expect(started.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(started.qrUrl).toBeUndefined();
    const secrets = await secretsFromCode(started.code!.toLowerCase());
    const t = s.transports[0]!;
    expect(t.id).toBe(secrets.sessionIdB64);
    const p = phone(secrets, t.phone);
    expect((await hello(p)).tv.label).toBe('Living room');
  });

  test('a wrong code never pairs', async () => {
    const s = setup();
    await s.host.start('code');
    const p = phone(await secretsFromCode(newPairingCode()), s.transports[0]!.phone);
    await p.ch.send({ t: 'hello', client: { kind: 'phone', label: 'x', protocol: 1 } });
    await settle(100);
    expect(p.inbox).toHaveLength(0);
    expect(s.host.status().state).toBe('waiting');
  });

  test('an unpaired session expires', async () => {
    const s = setup({ unpairedTtlMs: 80 });
    await s.host.start('qr');
    await until(() => s.host.status().state === 'expired');
    await until(() => s.transports[0]!.tv.closed);
    expect(s.events.some((e) => e.type === 'companion' && e.status.state === 'expired')).toBe(true);
  });

  test('a paired session expires at the paired lifetime and says bye', async () => {
    fakeTimers();
    const s = setup();
    const { p } = await pairQr(s);
    await hello(p);
    vi.advanceTimersByTime(PAIRED_TTL_MS - UNPAIRED_TTL_MS);
    expect(s.host.status().state).not.toBe('expired'); // the paired cap replaced the unpaired one
    vi.advanceTimersByTime(UNPAIRED_TTL_MS);
    await p.next('bye');
    expect(s.host.status()).toEqual({ state: 'expired', reason: 'expired' });
  });

  test('a message past the expiry ends the session (timers can be late after standby)', async () => {
    let skew = 0;
    const s = setup({ now: () => Date.now() + skew });
    const { p } = await pairQr(s);
    await hello(p);
    skew = PAIRED_TTL_MS;
    await p.ch.send({ t: 'getState' });
    await p.next('bye');
    expect(s.host.status()).toEqual({ state: 'expired', reason: 'expired' });
    expect(p.inbox.some((m) => m.t === 'state')).toBe(false);
  });

  test('the relay expiring the session (4000) marks it expired', async () => {
    const s = setup();
    const { p, t } = await pairQr(s);
    await hello(p);
    t.tv.finalClose('expired');
    expect(s.host.status()).toEqual({ state: 'expired', reason: 'expired' });
  });

  test.each([
    ['replaced', 'replaced'], ['rate-limit', 'rate-limit'], ['quota', 'quota'], ['unreachable', 'unreachable'],
    ['deadline', 'expired'], ['bad-role', 'stopped'],
  ])('a final transport close (%s) ends with reason %s, recorded in diagnostics', async (transportReason, reason) => {
    const s = setup();
    const { p, t } = await pairQr(s);
    await hello(p);
    t.tv.finalClose(transportReason);
    expect(s.host.status()).toEqual({ state: 'expired', reason });
    expect((await s.api.companionStatus()).reason).toBe(reason);
    const errors = (await s.api.diagnostics()).lastErrors;
    expect(errors.at(-1)).toMatchObject({ where: 'companion', message: `Phone session ended: ${reason}.` });
  });

  test('an unpaired session that times out has reason expired', async () => {
    const s = setup({ unpairedTtlMs: 50 });
    await s.host.start('code');
    await until(() => s.host.status().state === 'expired');
    expect(s.host.status().reason).toBe('expired');
  });

  test('reconnecting status while the transport is down; connected again after', async () => {
    const s = setup();
    const { p, t } = await pairQr(s);
    await hello(p);
    for (const fn of t.tv.disconnected) fn();
    expect(s.host.status().state).toBe('reconnecting');
    for (const fn of t.tv.reconnected) fn();
    expect(s.host.status().state).toBe('connected');
  });

  test('restarting replaces the session: the old phone gets bye and its transport closes', async () => {
    const s = setup();
    const first = await pairQr(s);
    await hello(first.p);
    const second = await pairQr(s);
    await first.p.next('bye');
    expect(first.t.tv.closed).toBe(true);
    expect(second.t.id).not.toBe(first.t.id);
    expect(s.host.status().state).toBe('waiting');
    // The new session works.
    await hello(second.p);
    expect(s.host.status().state).toBe('connected');
    // A message on the old pairing goes nowhere: neither the old phone nor the new one hears anything back.
    await first.p.ch.send({ t: 'getState' });
    await settle(100);
    expect(first.p.inbox).toEqual([]);
    expect(second.p.inbox.some((m) => m.t === 'state')).toBe(false);
    expect(s.host.status().state).toBe('connected');
  });

  test('stop() during an in-flight addSource: no result goes out and nothing throws', async () => {
    const s = setup();
    const { p } = await pairQr(s);
    await hello(p);
    let release!: (v: { sourceId: string; channelCount: number }) => void;
    const spy = vi.spyOn(s.api, 'addSource').mockImplementation(() => new Promise((r) => { release = r; }));
    const id = await p.ch.send({ t: 'addSource', input: xt() });
    await until(() => spy.mock.calls.length === 1);
    s.host.stop();
    await p.next('bye');
    release({ sourceId: 'x', channelCount: 0 });
    await settle(100);
    expect(p.inbox.some((m) => m.t === 'result' && m.requestMsgId === id)).toBe(false);
    expect(s.host.status()).toEqual({ state: 'idle' });
  });

  test('bye from the phone returns to waiting; stop() says bye and goes idle', async () => {
    const s = setup();
    const { p, t } = await pairQr(s);
    await hello(p);
    await p.ch.send({ t: 'bye' });
    await until(() => s.host.status().state === 'waiting');
    expect(s.host.status().peerLabel).toBeUndefined();
    await hello(p);
    s.host.stop();
    await p.next('bye');
    await until(() => t.tv.closed);
    expect(s.host.status()).toEqual({ state: 'idle' });
  });

  test('getState is single-flight and cached; haveVersion gets stateUnchanged until something changes', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    const spy = vi.spyOn(s.api, 'getCompanionState');
    await Promise.all([p.ch.send({ t: 'getState' }), p.ch.send({ t: 'getState' }), p.ch.send({ t: 'getState' })]);
    const states = [await p.next('state'), await p.next('state'), await p.next('state')];
    expect(spy).toHaveBeenCalledTimes(1);
    expect(states[1]).toEqual(states[0]);
    const v1 = states[0]!.state.version;

    await p.ch.send({ t: 'getState', haveVersion: v1 });
    expect((await p.next('stateUnchanged')).version).toBe(v1);
    // A version this companion never received is answered with the full state (from the cache).
    await p.ch.send({ t: 'getState', haveVersion: v1 + 7 });
    await p.next('state');
    expect(spy).toHaveBeenCalledTimes(1);

    // A layout change drops the cache and changes the version.
    const first = (await s.api.getChannelSlice('all', 0, 1)).rows[0]!;
    await s.api.toggleFavourite(first.id);
    await p.ch.send({ t: 'getState', haveVersion: v1 });
    const v2 = (await p.next('state')).state.version;
    expect(v2).toBeGreaterThan(v1);
    expect(spy).toHaveBeenCalledTimes(2);

    // A playlist refresh keeps the version but may change the channel set: full state again.
    await s.api.refresh('playlist');
    await p.ch.send({ t: 'getState', haveVersion: v2 });
    expect((await p.next('state')).state.version).toBe(v2);
    expect(spy).toHaveBeenCalledTimes(3);

    // A source change made on the TV (no event) also drops the cache.
    await s.api.addSource({ ...xt(), name: 'Second' });
    await p.ch.send({ t: 'getState', haveVersion: v2 });
    expect((await p.next('state')).state.sources).toHaveLength(2);
  });

  test('displayName is sent only for renamed channels', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    await p.ch.send({ t: 'getState' });
    const { state } = await p.next('state');
    expect(state.channels.every((c) => !('displayName' in c))).toBe(true);
    const id = state.channels[0]!.id;
    const renamed = await p.call({ t: 'ops', sourceId: state.activeSourceId!, baseVersion: state.version, ops: [{ op: 'renameChannel', id, name: 'Mine' }] });
    expect(renamed.ok).toBe(true);
    await p.ch.send({ t: 'getState' });
    const after = (await p.next('state')).state;
    expect(after.channels.find((c) => c.id === id)!.displayName).toBe('Mine');
    expect(after.channels.filter((c) => c.displayName !== undefined)).toHaveLength(1);
  });

  test('a state that does not fit the send queue gets Busy; the session stays connected', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p, t } = await pairQr(s);
    await hello(p);
    // Room for a small result, not for the state.
    t.tv.fits = (sizes) => sizes.reduce((a, b) => a + b, 0) < 400;
    const busy = await p.call({ t: 'getState' });
    expect(busy).toMatchObject({ ok: false, error: BUSY_ERROR });
    expect(s.host.status().state).toBe('connected');
    // Not even room for the result: dropped silently, still no session end.
    t.tv.fits = () => false;
    const id = await p.ch.send({ t: 'getState' });
    await settle(100);
    expect(p.inbox.some((m) => m.t === 'result' && m.requestMsgId === id)).toBe(false);
    expect(s.host.status().state).toBe('connected');
    delete t.tv.fits;
    await p.ch.send({ t: 'getState' });
    expect((await p.next('state')).state.channels).toHaveLength(40);
  });

  test('getState while the TV link is down gets Busy instead of a queued state', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p, t } = await pairQr(s);
    await hello(p);
    for (const fn of t.tv.disconnected) fn();
    const res = await p.call({ t: 'getState' });
    expect(res).toMatchObject({ ok: false, error: BUSY_ERROR });
    expect(p.inbox.some((m) => m.t === 'state')).toBe(false);
  });

  test('a layout change while the TV link is down is pushed after the reconnect', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p, t } = await pairQr(s);
    await hello(p);
    for (const fn of t.tv.disconnected) fn();
    const first = (await s.api.getChannelSlice('all', 0, 1)).rows[0]!;
    await s.api.toggleFavourite(first.id);
    await settle(100);
    expect(p.inbox.some((m) => m.t === 'layoutChanged')).toBe(false);
    for (const fn of t.tv.reconnected) fn();
    const m = await p.next('layoutChanged');
    expect(m.layout.lists[0]!.channelIds).toContain(first.id);
  });

  test('peer presence: 75 s of silence means waiting; any message (a ping) means connected again', async () => {
    fakeTimers();
    const s = setup();
    const { p } = await pairQr(s);
    await hello(p);
    const expiresAt = s.host.status().expiresAt;
    expect(s.host.status()).toMatchObject({ state: 'connected', peerLabel: 'My phone' });
    vi.advanceTimersByTime(PEER_TIMEOUT_MS - 1_000);
    expect(s.host.status().state).toBe('connected');
    vi.advanceTimersByTime(1_000);
    expect(s.host.status()).toEqual({ state: 'waiting', expiresAt });
    expect(s.statuses.at(-1)!.state).toBe('waiting');
    // The session continues: a ping brings the companion back, with the label from its last hello.
    await p.ch.send({ t: 'ping' });
    await until(() => s.host.status().state === 'connected');
    expect(s.host.status()).toEqual({ state: 'connected', peerLabel: 'My phone', expiresAt });
    // The ping restarted the countdown.
    vi.advanceTimersByTime(PEER_TIMEOUT_MS - 1_000);
    expect(s.host.status().state).toBe('connected');
    vi.advanceTimersByTime(1_000);
    expect(s.host.status().state).toBe('waiting');
  });

  test('messages before hello are served and mark the companion connected', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await p.ch.send({ t: 'getState' });
    expect((await p.next('state')).state.channels).toHaveLength(40);
    expect(s.host.status().state).toBe('connected');
    expect(s.host.status().peerLabel).toBeUndefined();
  });

  test('end() clears the cached state', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    await p.ch.send({ t: 'getState' });
    await p.next('state');
    const priv = s.host as unknown as { stateCache: unknown };
    expect(priv.stateCache).toBeDefined();
    s.host.stop();
    expect(priv.stateCache).toBeUndefined();
  });

  test('a state built before a newer change is rebuilt once before sending', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    const orig = s.api.getCompanionState.bind(s.api);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(s.api, 'getCompanionState').mockImplementationOnce(async () => {
      const st = await orig();
      await gate;
      return { ...st, version: 999 }; // a stale build
    });
    await p.ch.send({ t: 'getState' });
    await until(() => spy.mock.calls.length === 1);
    s.host.stateChanged(); // a layout change lands while the build is in flight
    release();
    const state = await p.next('state');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(state.state.version).not.toBe(999);
    await settle(100);
    expect(p.inbox.some((m) => m.t === 'state')).toBe(false); // exactly one state was sent
  });

  test('a rejected single-flight build answers every waiter with an error; the next request rebuilds', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    let fail!: () => void;
    const gate = new Promise<void>((_r, rej) => {
      fail = () => rej(Object.assign(new Error('failed at https://user:pw@tv.example.test/p?password=hunter2'), { name: 'BoomError' }));
    });
    const spy = vi.spyOn(s.api, 'getCompanionState').mockImplementationOnce(() => gate as never);
    const ids = await Promise.all([p.ch.send({ t: 'getState' }), p.ch.send({ t: 'getState' }), p.ch.send({ t: 'getState' })]);
    await settle(150); // all three are waiting on the one build
    fail();
    const results = [];
    for (const id of ids) results.push(await p.next('result', (r) => r.requestMsgId === id));
    expect(spy).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.ok).toBe(false);
    expect(JSON.stringify(results)).not.toContain('hunter2');
    expect(JSON.stringify(results)).not.toContain('pw@');
    await p.ch.send({ t: 'getState' });
    expect((await p.next('state')).state.channels).toHaveLength(40);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(s.host.status().state).toBe('connected');
  });

  test('a state that cannot be sent for another reason gets a scrubbed error result', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    const channel = (s.host as unknown as { session: { channel: { send: (m: TvToPhone, o?: unknown) => Promise<number> } } }).session.channel;
    const real = channel.send.bind(channel);
    vi.spyOn(channel, 'send').mockImplementation((m, o) => (m.t === 'state'
      ? Promise.reject(new Error('seal failed for https://u:pw@tv.example.test/x?password=hunter2'))
      : real(m, o)));
    const res = await p.call({ t: 'getState' });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('hunter2');
    expect(JSON.stringify(res)).not.toContain('pw@');
  });

  test('messages of an unknown type are dropped without closing; malformed known messages still close', async () => {
    const s = setup();
    await s.api.addSource(xt());
    const { p } = await pairQr(s);
    await hello(p);
    const send = (m: unknown) => p.ch.send(m as PhoneToTv);
    for (let i = 0; i < 8; i++) await send({ t: 'fromTheFuture', n: i });
    await settle(100);
    expect(s.host.status().state).toBe('connected');
    await p.ch.send({ t: 'getState' });
    await p.next('state'); // still served
    // A hello without a protocol version is malformed.
    for (let i = 0; i < 5; i++) await send({ t: 'hello', client: { kind: 'phone', label: 'x' } });
    await until(() => s.host.status().state === 'expired');
    expect(s.host.status().reason).toBe('peer-errors');
  });

  test('a reconnect gives the companion a fresh presence countdown', async () => {
    fakeTimers();
    const s = setup();
    const { p, t } = await pairQr(s);
    await hello(p);
    vi.advanceTimersByTime(PEER_TIMEOUT_MS - 5_000);
    for (const fn of t.tv.disconnected) fn();
    for (const fn of t.tv.reconnected) fn();
    vi.advanceTimersByTime(10_000); // past the original deadline
    expect(s.host.status().state).toBe('connected');
    vi.advanceTimersByTime(PEER_TIMEOUT_MS);
    expect(s.host.status().state).toBe('waiting');
  });

  test('AppApi exposes companionStart / companionStatus / companionStop and emits status events', async () => {
    const s = setup();
    const started = await s.api.companionStart('qr');
    expect(started.qrUrl).toBeDefined();
    expect((await s.api.companionStatus()).state).toBe('waiting');
    await s.api.companionStop();
    expect((await s.api.companionStatus()).state).toBe('idle');
    const states = s.events.filter((e) => e.type === 'companion').map((e) => (e as { status: CompanionStatus }).status.state);
    expect(states).toEqual(['waiting', 'idle']);
  });
});

describe('validateSourceInput limits', () => {
  test('the source name is at most NAME_MAX (after trimming), like the TV form', async () => {
    const { NAME_MAX } = await import('@iptv/core');
    const { validateSourceInput } = await import('../src/companionHost.ts');
    const base = { kind: 'm3u' as const, playlistUrl: 'http://example.test/a.m3u' };
    expect(validateSourceInput({ ...base, name: 'n'.repeat(NAME_MAX + 1) }))
      .toEqual({ ok: false, message: `Use a name of ${NAME_MAX} characters or fewer.` });
    expect(validateSourceInput({ ...base, name: ` ${'n'.repeat(NAME_MAX)} ` }).ok).toBe(true);
  });
});

describe('fitCompanionState', () => {
  const synthetic = (n: number, logo: (i: number) => string | undefined): CompanionState => ({
    version: 1,
    sources: [{ id: 's1', name: 'Mine', kind: 'm3u', active: true }],
    activeSourceId: 's1',
    groups: [],
    channels: Array.from({ length: n }, (_, i) => {
      const c: CompanionState['channels'][number] = {
        id: `c${i}`, name: `Channel ${i} HD`, displayName: `Channel ${i} HD`, group: `Group ${i % 50}`, number: i + 1, hasEpg: true,
      };
      const l = logo(i);
      if (l) c.logo = l;
      return c;
    }),
    layout: { version: 1, lists: [], hiddenChannels: [], hiddenGroups: [], channelNames: {}, groupNames: {}, groupOrder: [], channelOrder: {}, sort: {}, hideNoEpg: false, watched: [] } as unknown as CompanionState['layout'],
    coverageKnown: true,
  });
  const size = (s: CompanionState) => new TextEncoder().encode(JSON.stringify({ t: 'state', state: s })).length;

  test('a small state is unchanged', () => {
    const s = synthetic(10, (i) => `http://logos.example.test/${i}.png`);
    expect(fitCompanionState(s)).toBe(s);
  });

  test('50k channels with long logos fit the message cap; every channel is kept', () => {
    const s = synthetic(50_000, (i) => `http://logos.example.test/a/very/long/path/to/the/channel/logo/${i}.png?size=large&v=1`
      + (i % 10 === 0 ? 'x'.repeat(LOGO_MAX_CHARS) : ''));
    expect(size(s)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const fit = fitCompanionState(s);
    expect(size(fit)).toBeLessThanOrEqual(STATE_BUDGET_BYTES);
    expect(STATE_BUDGET_BYTES).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(fit.channels).toHaveLength(50_000);
    expect(fit.channels[1]!.name).toBe('Channel 1 HD');
  });

  test('oversized logos (e.g. data: URIs) are dropped first, short ones kept when that is enough', () => {
    const s = synthetic(1_000, (i) => (i === 0 ? `data:image/png;base64,${'A'.repeat(STATE_BUDGET_BYTES)}` : `http://logos.example.test/${i}.png`));
    const fit = fitCompanionState(s);
    expect(fit.channels[0]!.logo).toBeUndefined();
    expect(fit.channels[1]!.logo).toBe('http://logos.example.test/1.png');
    expect(size(fit)).toBeLessThanOrEqual(STATE_BUDGET_BYTES);
  });

  test('a state still too large without logos throws StateTooLargeError', () => {
    const s = synthetic(60_000, () => undefined);
    for (const c of s.channels) c.name = c.displayName = 'n'.repeat(80);
    expect(() => fitCompanionState(s)).toThrow(expect.objectContaining({ name: 'StateTooLargeError' }));
  });
});
