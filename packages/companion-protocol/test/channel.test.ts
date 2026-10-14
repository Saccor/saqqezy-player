import { afterEach, describe, expect, test, vi } from 'vitest';
import { emptyLayout, MAX_OPS_PER_BATCH, NAME_MAX, type LayoutOp } from '@iptv/core';
import {
  isPhoneToTv,
  isUnknownPhoneMessage,
  isTvToPhone,
  openFrame,
  QueueFullError,
  sealMessage,
  SecureChannel,
  toB64Url,
  type CompanionState,
  type FrameTransport,
  type PairingSecrets,
  type PhoneToTv,
  type TvToPhone,
} from '../src/index.ts';

const MIB = 1024 * 1024;

const hasCompression = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function newSecrets(): Promise<PairingSecrets> {
  const sessionId = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { sessionId, key, sessionIdB64: toB64Url(sessionId) };
}

interface TestTransport extends FrameTransport {
  /** Frames this end has sent, in order. */
  sent: Uint8Array[];
  /** Delivers a frame to this end's listeners, as if it came from the peer. */
  inject(frame: Uint8Array): void;
  closed: boolean;
}

/** Two in-memory transports wired to each other. Delivery is asynchronous, like a socket. */
function transportPair(): [TestTransport, TestTransport] {
  const make = (): TestTransport & { peer?: TestTransport; listeners: Set<(f: Uint8Array) => void> } => {
    const t: TestTransport & { peer?: TestTransport; listeners: Set<(f: Uint8Array) => void> } = {
      sent: [],
      closed: false,
      listeners: new Set(),
      send(frame) {
        if (t.closed) throw new Error('closed');
        t.sent.push(frame);
        const peer = t.peer;
        if (peer) setTimeout(() => peer.inject(frame), 0);
      },
      onFrame(fn) {
        t.listeners.add(fn);
        return () => t.listeners.delete(fn);
      },
      close() {
        t.closed = true;
      },
      inject(frame) {
        if (t.closed) return;
        for (const fn of [...t.listeners]) fn(frame);
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

const flagsOf = (frames: Uint8Array[]) => frames.map((f) => f[1]);

async function pair() {
  const secrets = await newSecrets();
  const [tvT, phoneT] = transportPair();
  const tv = new SecureChannel<TvToPhone, PhoneToTv>({ secrets, role: 'tv', transport: tvT, validate: isPhoneToTv });
  const phone = new SecureChannel<PhoneToTv, TvToPhone>({ secrets, role: 'phone', transport: phoneT, validate: isTvToPhone });
  return { secrets, tvT, phoneT, tv, phone };
}

function collect<T>(ch: { onMessage(fn: (m: T, id: number) => void): () => void }) {
  const got: { msg: T; msgId: number }[] = [];
  ch.onMessage((msg, msgId) => got.push({ msg, msgId }));
  return got;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** A synthetic companion state of at least `minBytes` JSON bytes; random names keep gzip from shrinking it to one chunk. */
function bigState(minBytes: number): CompanionState {
  const channels: CompanionState['channels'] = [];
  let size = 0;
  for (let i = 0; size < minBytes; i++) {
    const name = `Channel ${randomHex(60)}`;
    channels.push({
      id: `ch-${i}`, name, displayName: name, group: `g-${i % 50}`, number: i + 1,
      logo: `https://logos.example.test/${i}.png`, hasEpg: i % 2 === 0,
    });
    size += 260;
  }
  return {
    version: 3,
    activeSourceId: 'src-1',
    sources: [{ id: 'src-1', name: 'Home', kind: 'm3u', active: true }],
    groups: [{ id: 'g-0', name: 'Group 0', count: 1 } as CompanionState['groups'][number]],
    channels,
    layout: emptyLayout(),
    coverageKnown: true,
  };
}

describe('SecureChannel', () => {
  test('exchanges typed messages both ways', async () => {
    const { tv, phone } = await pair();
    const atTv = collect(tv);
    const atPhone = collect(phone);

    const id1 = await phone.send({ t: 'hello', client: { kind: 'phone', label: 'My phone', protocol: 1 } });
    const id2 = await phone.send({ t: 'getState' });
    await tv.send({ t: 'welcome', tv: { label: 'Living room', appVersion: '1.1.0', protocol: 1 } });
    await until(() => atTv.length === 2 && atPhone.length === 1);

    expect(atTv.map((m) => m.msg)).toEqual([
      { t: 'hello', client: { kind: 'phone', label: 'My phone', protocol: 1 } },
      { t: 'getState' },
    ]);
    expect(atTv.map((m) => m.msgId)).toEqual([id1, id2]);
    expect(id2).toBe((id1 + 1) >>> 0);
    expect(atPhone[0]!.msg).toEqual({ t: 'welcome', tv: { label: 'Living room', appVersion: '1.1.0', protocol: 1 } });
  });

  test('carries a 3 MiB state message (multi-chunk)', async () => {
    const { tv, phone, tvT } = await pair();
    const atPhone = collect(phone);
    const state = bigState(3 * MIB);
    expect(JSON.stringify(state).length).toBeGreaterThanOrEqual(3 * MIB);

    await tv.send({ t: 'state', state });
    expect(tvT.sent.length).toBeGreaterThan(1);
    await until(() => atPhone.length === 1, 20000);
    expect(atPhone[0]!.msg).toEqual({ t: 'state', state });
  }, 30000);

  test('sends are serialised: frames of different messages never interleave', async () => {
    const { tv, phone, tvT } = await pair();
    const atPhone = collect(phone);
    const state = bigState(2 * MIB);
    const p1 = tv.send({ t: 'state', state });
    const p2 = tv.send({ t: 'progress', phase: 'playlist', count: 5 });
    const [a, b] = await Promise.all([p1, p2]);
    expect(b).toBe((a + 1) >>> 0);
    const ids = tvT.sent.map((f) => new DataView(f.buffer, f.byteOffset).getUint32(2));
    const firstB = ids.indexOf(b);
    expect(ids.slice(0, firstB).every((id) => id === a)).toBe(true);
    expect(ids.slice(firstB).every((id) => id === b)).toBe(true);
    await until(() => atPhone.length === 2, 20000);
    expect(atPhone.map((m) => m.msg.t)).toEqual(['state', 'progress']);
  }, 30000);

  test('drops payloads that decrypt but fail validation', async () => {
    const { secrets, tv, tvT } = await pair();
    const atTv = collect(tv);
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));

    const bad: unknown[] = [
      { t: 'nope' },
      { t: 'ops', baseVersion: 1, ops: [{ op: 'explode' }] },
      'just a string',
    ];
    let msgId = 100;
    for (const value of bad) {
      for (const f of await sealMessage(secrets.key, secrets.sessionId, 'phone->tv', msgId++, value)) tvT.inject(f);
    }
    for (const f of await sealMessage(secrets.key, secrets.sessionId, 'phone->tv', msgId++, { t: 'getState' })) tvT.inject(f);
    await until(() => atTv.length === 1);
    await settle();
    expect(atTv.map((m) => m.msg)).toEqual([{ t: 'getState' }]);
    expect(closes).toEqual([]);
  });

  test('a message whose msgId was already accepted is dropped (replay), multi-chunk included', async () => {
    const { tv, phone, phoneT, tvT } = await pair();
    const atTv = collect(tv);
    const ops: LayoutOp[] = [{ op: 'hideChannels', ids: Array.from({ length: 1000 }, () => randomHex(400)) }];
    await phone.send({ t: 'ops', baseVersion: 0, ops });
    expect(phoneT.sent.length).toBeGreaterThan(1);
    await until(() => atTv.length === 1, 10000);

    for (const f of phoneT.sent.slice()) tvT.inject(f);
    await settle();
    expect(atTv.length).toBe(1);

    await phone.send({ t: 'getState' });
    await until(() => atTv.length === 2);
  }, 20000);

  test('5 garbage frames before the first message close the channel with reason peer-errors', async () => {
    const { tv, tvT } = await pair();
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    const garbage = () => crypto.getRandomValues(new Uint8Array(80));

    for (let i = 0; i < 4; i++) tvT.inject(garbage());
    await settle();
    expect(closes).toEqual([]);

    tvT.inject(garbage());
    await until(() => closes.length > 0);
    expect(closes).toEqual(['peer-errors']);
    expect(tvT.closed).toBe(true);
    await expect(tv.send({ t: 'bye' })).rejects.toThrow();
  });

  test('frames sealed for the other direction count as failures', async () => {
    const { secrets, tv, tvT } = await pair();
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    for (let i = 0; i < 5; i++) {
      for (const f of await sealMessage(secrets.key, secrets.sessionId, 'tv->phone', 1 + i, { t: 'getState' })) tvT.inject(f);
    }
    await until(() => closes.length > 0);
    expect(closes).toEqual(['peer-errors']);
  });

  describe('failure policy', () => {
    const garbage = () => crypto.getRandomValues(new Uint8Array(80));
    const good = async (secrets: PairingSecrets, id: number, v: unknown = { t: 'getState' }) =>
      sealMessage(secrets.key, secrets.sessionId, 'phone->tv', id, v);

    test('4 bad, 1 good, 4 bad: stays open (the good message resets the count)', async () => {
      const { secrets, tv, tvT } = await pair();
      const atTv = collect(tv);
      const closes: string[] = [];
      tv.onClose((r) => closes.push(r));
      for (let i = 0; i < 4; i++) tvT.inject(garbage());
      for (const f of await good(secrets, 10)) tvT.inject(f);
      await until(() => atTv.length === 1);
      for (let i = 0; i < 4; i++) tvT.inject(garbage());
      await settle();
      expect(closes).toEqual([]);
    });

    test('unknown message types are dropped and counted without closing; malformed known ones still close', async () => {
      const secrets = await newSecrets();
      const [tvT] = transportPair();
      const tv = new SecureChannel<TvToPhone, PhoneToTv>({
        secrets, role: 'tv', transport: tvT, validate: isPhoneToTv, isUnknown: isUnknownPhoneMessage,
      });
      const atTv = collect(tv);
      const closes: string[] = [];
      tv.onClose((r) => closes.push(r));
      for (let i = 0; i < 8; i++) for (const f of await good(secrets, 10 + i, { t: 'fromTheFuture', i })) tvT.inject(f);
      for (const f of await good(secrets, 30)) tvT.inject(f);
      await until(() => atTv.length === 1);
      expect(tv.unknownCount).toBe(8);
      expect(closes).toEqual([]);
      for (let i = 0; i < 5; i++) for (const f of await good(secrets, 40 + i, { t: 'getSource' })) tvT.inject(f);
      await until(() => closes.length > 0);
      expect(closes).toEqual(['peer-errors']);
      expect(tv.unknownCount).toBe(8);
    });

    test('garbage after authentication never closes the channel', async () => {
      const { secrets, tv, tvT } = await pair();
      const atTv = collect(tv);
      const closes: string[] = [];
      tv.onClose((r) => closes.push(r));
      for (const f of await good(secrets, 10)) tvT.inject(f);
      await until(() => atTv.length === 1);
      for (let i = 0; i < 50; i++) tvT.inject(garbage());
      await settle();
      expect(closes).toEqual([]);
      for (const f of await good(secrets, 11)) tvT.inject(f);
      await until(() => atTv.length === 2);
    });

    test('post-auth validation failures still count and close with peer-errors', async () => {
      const { secrets, tv, tvT } = await pair();
      const atTv = collect(tv);
      const closes: string[] = [];
      tv.onClose((r) => closes.push(r));
      for (const f of await good(secrets, 10)) tvT.inject(f);
      await until(() => atTv.length === 1);
      for (let i = 0; i < 5; i++) for (const f of await good(secrets, 20 + i, { t: 'nope' })) tvT.inject(f);
      await until(() => closes.length > 0);
      expect(closes).toEqual(['peer-errors']);
    });

    test('a throwing validator counts as a failure and never stalls the receive chain', async () => {
      const secrets = await newSecrets();
      const [tvT] = transportPair();
      let throwing = true;
      const tv = new SecureChannel<TvToPhone, PhoneToTv>({
        secrets, role: 'tv', transport: tvT,
        validate: (x): x is PhoneToTv => {
          if (throwing) throw new Error('boom');
          return isPhoneToTv(x);
        },
      });
      const atTv = collect(tv);
      const closes: string[] = [];
      tv.onClose((r) => closes.push(r));
      for (const f of await good(secrets, 10)) tvT.inject(f);
      await settle();
      throwing = false;
      for (const f of await good(secrets, 11)) tvT.inject(f);
      await until(() => atTv.length === 1);
      expect(closes).toEqual([]);

      throwing = true;
      for (let i = 0; i < 5; i++) for (const f of await good(secrets, 30 + i)) tvT.inject(f);
      await until(() => closes.length > 0);
      expect(closes).toEqual(['peer-errors']);
    });

    test('a compressed phone->tv frame is rejected before any inflate', async () => {
      const { secrets, tv, tvT } = await pair();
      const atTv = collect(tv);
      const frames = await sealMessage(secrets.key, secrets.sessionId, 'phone->tv', 5, { t: 'getState' });
      const f = frames[0]!.slice();
      f[1] = 1; // set the compressed flag
      await expect(openFrame(secrets.key, secrets.sessionId, 'phone->tv', f)).rejects.toThrow(/compressed/);
      tvT.inject(f);
      await settle();
      expect(atTv.length).toBe(0);
    });
  });

  describe('transport lifecycle', () => {
    function closableTransport(): TestTransport & { listeners: Set<(f: Uint8Array) => void>; fireClose(): void } {
      const [t] = transportPair();
      const fns = new Set<() => void>();
      return Object.assign(t as TestTransport & { listeners: Set<(f: Uint8Array) => void> }, {
        onClose(fn: () => void) {
          fns.add(fn);
          return () => fns.delete(fn);
        },
        fireClose() {
          for (const fn of [...fns]) fn();
        },
      });
    }

    test('a transport-initiated onClose closes the channel with reason transport', async () => {
      const secrets = await newSecrets();
      const t = closableTransport();
      const ch = new SecureChannel<TvToPhone, PhoneToTv>({ secrets, role: 'tv', transport: t, validate: isPhoneToTv });
      const closes: string[] = [];
      ch.onClose((r) => closes.push(r));
      t.fireClose();
      expect(closes).toEqual(['transport']);
    });

    test('a stale onClose from an old transport after setTransport is ignored', async () => {
      const secrets = await newSecrets();
      const oldT = closableTransport();
      const ch = new SecureChannel<TvToPhone, PhoneToTv>({ secrets, role: 'tv', transport: oldT, validate: isPhoneToTv });
      const closes: string[] = [];
      ch.onClose((r) => closes.push(r));
      const newT = closableTransport();
      ch.setTransport(newT);
      oldT.fireClose();
      expect(closes).toEqual([]);
      await ch.send({ t: 'bye' });
      newT.fireClose();
      expect(closes).toEqual(['transport']);
    });

    test('frames from the old transport are dropped after setTransport', async () => {
      const secrets = await newSecrets();
      const oldT = closableTransport();
      const ch = new SecureChannel<TvToPhone, PhoneToTv>({ secrets, role: 'tv', transport: oldT, validate: isPhoneToTv });
      const atTv = collect(ch);
      const frames = await sealMessage(secrets.key, secrets.sessionId, 'phone->tv', 7, { t: 'getState' });
      // Keep a handle on the channel's old listener, as a transport with a late in-flight delivery would.
      const listener = [...oldT.listeners][0]!;
      ch.setTransport(closableTransport());
      listener(frames[0]!);
      await settle();
      expect(atTv.length).toBe(0);
    });
  });

  test('close() fires onClose once with reason closed and closes the transport', async () => {
    const { tv, tvT } = await pair();
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    tv.close();
    tv.close();
    expect(closes).toEqual(['closed']);
    expect(tvT.closed).toBe(true);
  });

  test('msgIds start at a random offset with at least 2^31 ids of headroom', async () => {
    const firsts = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const { phone } = await pair();
      const id = await phone.send({ t: 'getState' });
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(0x7fffffff);
      firsts.add(id);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });

  test('the channel closes instead of wrapping its msgId counter', async () => {
    const { phone, phoneT } = await pair();
    const closes: string[] = [];
    phone.onClose((r) => closes.push(r));
    (phone as unknown as { nextMsgId: number }).nextMsgId = 0xffffffff;
    expect(await phone.send({ t: 'getState' })).toBe(0xffffffff);
    await expect(phone.send({ t: 'getState' })).rejects.toThrow();
    expect(closes).toEqual(['msgid-exhausted']);
    expect(phoneT.closed).toBe(true);
    expect(phoneT.sent.length).toBe(1);
  });

  test('setTransport: reconnecting keeps the msgId counter and the replay window', async () => {
    const { tv, phone, phoneT, tvT } = await pair();
    const atTv = collect(tv);
    const atPhone = collect(phone);
    const id1 = await phone.send({ t: 'getState' });
    await until(() => atTv.length === 1);
    const oldFrames = phoneT.sent.slice();

    const [tvT2, phoneT2] = transportPair();
    tv.setTransport(tvT2);
    phone.setTransport(phoneT2);

    // The old transports no longer reach the channels.
    tvT.inject(oldFrames[0]!);
    const id2 = await phone.send({ t: 'refresh', what: 'epg' });
    expect(id2).toBe(id1 + 1);
    expect(phoneT.sent.length).toBe(oldFrames.length);
    await until(() => atTv.length === 2);
    expect(atTv.map((m) => m.msgId)).toEqual([id1, id2]);

    // Frames from before the reconnect, replayed over the new transport, are dropped.
    for (const f of oldFrames) tvT2.inject(f);
    await settle();
    expect(atTv.length).toBe(2);

    await tv.send({ t: 'bye' });
    await until(() => atPhone.length === 1);
  });

  test('setTransport on a closed channel throws', async () => {
    const { tv } = await pair();
    tv.close();
    const [t] = transportPair();
    expect(() => tv.setTransport(t)).toThrow();
  });

  test.skipIf(!hasCompression)('phone->tv frames are never compressed; tv->phone frames are', async () => {
    const { tv, phone, phoneT, tvT } = await pair();
    const atTv = collect(tv);
    const atPhone = collect(phone);
    const ops: LayoutOp[] = [{ op: 'hideChannels', ids: Array.from({ length: 2000 }, (_, i) => `channel-${i}`) }];
    await phone.send({ t: 'ops', baseVersion: 0, ops });
    expect(flagsOf(phoneT.sent).every((f) => f === 0)).toBe(true);
    await tv.send({ t: 'state', state: bigState(10_000) });
    expect(flagsOf(tvT.sent).every((f) => f === 1)).toBe(true);
    await until(() => atTv.length === 1 && atPhone.length === 1);
  });

  test('a TV without DecompressionStream reads every phone message', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    const { tv, phone, phoneT } = await pair();
    const atTv = collect(tv);
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    const msgs: PhoneToTv[] = [
      { t: 'hello', client: { kind: 'phone', label: 'My phone', protocol: 1 } },
      { t: 'getState' },
      { t: 'getSource', id: 'src-1' },
      { t: 'ops', baseVersion: 4, ops: [{ op: 'hideChannels', ids: Array.from({ length: 5000 }, (_, i) => `ch-${i}`) }] },
      { t: 'addSource', input: { kind: 'm3u', name: 'Home', playlistUrl: 'https://media.example.test/list.m3u' } },
      { t: 'updateSource', source: { kind: 'xtream', id: 'src-1', name: 'X', server: 'https://x.example.test', username: 'u', password: 'p' } },
      { t: 'deleteSource', id: 'src-1' },
      { t: 'setActiveSource', id: 'src-1' },
      { t: 'refresh', what: 'both' },
      { t: 'bye' },
    ];
    for (const m of msgs) await phone.send(m);
    await until(() => atTv.length === msgs.length);
    expect(atTv.map((m) => m.msg)).toEqual(msgs);
    expect(flagsOf(phoneT.sent).every((f) => f === 0)).toBe(true);
    expect(closes).toEqual([]);
  });

  test('a message that does not fit the transport is rejected whole; the channel stays open', async () => {
    const { tv, tvT, phone } = await pair();
    const atPhone = collect(phone);
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    const sizes: number[][] = [];
    let room = true;
    tvT.fits = (frameBytes) => {
      sizes.push([...frameBytes]);
      return room;
    };
    room = false;
    await expect(tv.send({ t: 'state', state: bigState(1 * MIB) })).rejects.toBeInstanceOf(QueueFullError);
    expect(sizes[0]!.length).toBeGreaterThan(1); // every frame of the message was checked at once
    expect(tvT.sent).toHaveLength(0);
    room = true;
    await tv.send({ t: 'bye' });
    await until(() => atPhone.length === 1);
    expect(atPhone[0]!.msg).toEqual({ t: 'bye' });
    expect(closes).toEqual([]);
  });

  test('a QueueFullError from send() rejects that message only', async () => {
    const { tv, tvT } = await pair();
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    const send = tvT.send.bind(tvT);
    tvT.send = () => { throw new QueueFullError(); };
    await expect(tv.send({ t: 'bye' })).rejects.toBeInstanceOf(QueueFullError);
    tvT.send = send;
    await tv.send({ t: 'bye' });
    expect(closes).toEqual([]);
  });

  test('send() uses a pre-serialised json when given', async () => {
    const { tv, phone } = await pair();
    const atPhone = collect(phone);
    const msg: TvToPhone = { t: 'stateUnchanged', version: 4 };
    await tv.send(msg, { json: JSON.stringify({ t: 'stateUnchanged', version: 5 }) });
    await until(() => atPhone.length === 1);
    expect(atPhone[0]!.msg).toEqual({ t: 'stateUnchanged', version: 5 });
  });

  test('a transport that fails to send closes the channel with reason transport', async () => {
    const { tv, tvT } = await pair();
    const closes: string[] = [];
    tv.onClose((r) => closes.push(r));
    tvT.closed = true; // send() now throws
    await expect(tv.send({ t: 'bye' })).rejects.toThrow();
    expect(closes).toEqual(['transport']);
  });
});

describe('isPhoneToTv', () => {
  const valid: PhoneToTv[] = [
    { t: 'hello', client: { kind: 'desktop', label: 'Laptop', protocol: 1 } },
    { t: 'getState' },
    { t: 'getState', haveVersion: 0 },
    { t: 'ping' },
    { t: 'getSource', id: 'src-1' },
    { t: 'ops', baseVersion: 4, ops: [{ op: 'hideChannels', ids: ['a', 'b'] }, { op: 'setHideNoEpg', value: true }] },
    { t: 'addSource', input: { kind: 'm3u', name: 'Home', playlistUrl: 'https://media.example.test/list.m3u' } },
    { t: 'addSource', input: { kind: 'xtream', name: 'X', server: 'https://x.example.test', username: 'u', password: 'p' } },
    { t: 'updateSource', source: { kind: 'm3u', id: 'src-1', name: 'Home', playlistUrl: 'https://media.example.test/l.m3u', epgUrl: 'https://media.example.test/e.xml' } },
    { t: 'deleteSource', id: 'src-1' },
    { t: 'setActiveSource', id: 'src-1' },
    { t: 'refresh', what: 'both' },
    { t: 'bye' },
  ];

  test.each(valid.map((v) => [v.t, v] as const))('accepts %s', (_t, v) => {
    expect(isPhoneToTv(v)).toBe(true);
  });

  test('rejects unknown t values and non-objects', () => {
    for (const x of [null, undefined, 1, 'getState', [], {}, { t: 'nope' }, { t: 'welcome', tv: { label: 'a', appVersion: '1' } }, { t: 7 }]) {
      expect(isPhoneToTv(x)).toBe(false);
    }
  });

  test('rejects a bad op and oversize batches', () => {
    expect(isPhoneToTv({ t: 'ops', baseVersion: 1, ops: [{ op: 'explode' }] })).toBe(false);
    expect(isPhoneToTv({ t: 'ops', baseVersion: 1, ops: [{ op: 'hideChannels', ids: 'a' }] })).toBe(false);
    expect(isPhoneToTv({ t: 'ops', baseVersion: 1, ops: {} })).toBe(false);
    expect(isPhoneToTv({ t: 'ops', baseVersion: -1, ops: [] })).toBe(false);
    expect(isPhoneToTv({ t: 'ops', baseVersion: 1.5, ops: [] })).toBe(false);
    const many = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => ({ op: 'setHideNoEpg', value: true }));
    expect(isPhoneToTv({ t: 'ops', baseVersion: 1, ops: many })).toBe(false);
  });

  test('caps and required strings', () => {
    const m3u = (o: Record<string, unknown>) => ({ t: 'addSource', input: { kind: 'm3u', name: 'Home', playlistUrl: 'https://media.example.test/l.m3u', ...o } });
    const xt = (o: Record<string, unknown>) => ({ t: 'addSource', input: { kind: 'xtream', name: 'X', server: 'https://x.example.test', username: 'u', password: 'p', ...o } });
    expect(isPhoneToTv({ t: 'hello', client: { kind: 'phone', label: 'a'.repeat(128), protocol: 1 } })).toBe(true);
    expect(isPhoneToTv({ t: 'hello', client: { kind: 'phone', label: 'a'.repeat(129), protocol: 1 } })).toBe(false);
    expect(isPhoneToTv(m3u({ name: 'a'.repeat(NAME_MAX) }))).toBe(true);
    expect(isPhoneToTv(m3u({ name: 'a'.repeat(NAME_MAX + 1) }))).toBe(false);
    expect(isPhoneToTv(xt({ name: 'a'.repeat(NAME_MAX + 1) }))).toBe(false);
    expect(isPhoneToTv(xt({ server: '' }))).toBe(false);
    expect(isPhoneToTv(xt({ username: '' }))).toBe(false);
    expect(isPhoneToTv(xt({ password: '' }))).toBe(false);
    expect(isPhoneToTv(m3u({ playlistUrl: '' }))).toBe(false);
  });

  test('URLs must be http(s); an Xtream server may omit the scheme', () => {
    const m3u = (o: Record<string, unknown>) => ({ t: 'addSource', input: { kind: 'm3u', name: 'Home', playlistUrl: 'https://media.example.test/l.m3u', ...o } });
    const xt = (server: string) => ({ t: 'addSource', input: { kind: 'xtream', name: 'X', server, username: 'u', password: 'p' } });
    expect(isPhoneToTv(m3u({ playlistUrl: 'http://media.example.test/l.m3u' }))).toBe(true);
    expect(isPhoneToTv(m3u({ playlistUrl: 'file:///etc/passwd' }))).toBe(false);
    expect(isPhoneToTv(m3u({ playlistUrl: 'javascript:alert(1)' }))).toBe(false);
    expect(isPhoneToTv(m3u({ playlistUrl: 'media.example.test/l.m3u' }))).toBe(false);
    expect(isPhoneToTv(m3u({ playlistUrl: 'ftp://media.example.test/l.m3u' }))).toBe(false);
    expect(isPhoneToTv(m3u({ epgUrl: 'https://media.example.test/e.xml' }))).toBe(true);
    expect(isPhoneToTv(m3u({ epgUrl: 'ftp://media.example.test/e.xml' }))).toBe(false);
    expect(isPhoneToTv(m3u({ epgUrl: '' }))).toBe(false);
    expect(isPhoneToTv(xt('x.example.test'))).toBe(true);
    expect(isPhoneToTv(xt('x.example.test:8080'))).toBe(true);
    expect(isPhoneToTv(xt('x.example.test:8080/path'))).toBe(true);
    expect(isPhoneToTv(xt('http://x.example.test:8080'))).toBe(true);
    expect(isPhoneToTv(xt('ftp://x.example.test'))).toBe(false);
    expect(isPhoneToTv(xt('file:///etc/passwd'))).toBe(false);
    expect(isPhoneToTv(xt('javascript:alert(1)'))).toBe(false);
  });

  test('ops: unknown keys per op type are rejected', () => {
    const ops = (op: Record<string, unknown>) => ({ t: 'ops', baseVersion: 1, ops: [op] });
    expect(isPhoneToTv(ops({ op: 'hideChannels', ids: ['a'] }))).toBe(true);
    expect(isPhoneToTv(ops({ op: 'hideChannels', ids: ['a'], extra: 1 }))).toBe(false);
    expect(isPhoneToTv(ops({ op: 'setHideNoEpg', value: true, extra: 1 }))).toBe(false);
    expect(isPhoneToTv(ops({ op: 'createList', id: 'l1', name: 'Mine', extra: 1 }))).toBe(false);
    expect(isPhoneToTv(ops({ op: 'moveInList', listId: 'l', channelId: 'c', toIndex: 0, ids: [] }))).toBe(false);
    expect(isPhoneToTv(ops({ op: 'markWatched', id: 'a', note: 'x' }))).toBe(false);
    expect(isPhoneToTv(ops({ op: 'hideChannels' }))).toBe(false);
  });

  test('rejects wrong field types and unknown fields', () => {
    expect(isPhoneToTv({ t: 'hello', client: { kind: 'tv', label: 'x' } })).toBe(false);
    expect(isPhoneToTv({ t: 'hello', client: { kind: 'phone' } })).toBe(false);
    expect(isPhoneToTv({ t: 'hello', client: { kind: 'phone', label: 'x' } })).toBe(false); // protocol is required
    expect(isPhoneToTv({ t: 'hello', client: { kind: 'phone', label: 'x', protocol: -1 } })).toBe(false);
    expect(isTvToPhone({ t: 'welcome', tv: { label: 'a', appVersion: '1' } })).toBe(false);
    expect(isPhoneToTv({ t: 'getSource', id: '' })).toBe(false);
    expect(isPhoneToTv({ t: 'getSource', id: 5 })).toBe(false);
    expect(isPhoneToTv({ t: 'refresh', what: 'all' })).toBe(false);
    expect(isPhoneToTv({ t: 'getState', extra: 1 })).toBe(false);
    expect(isPhoneToTv({ t: 'getState', haveVersion: -1 })).toBe(false);
    expect(isPhoneToTv({ t: 'getState', haveVersion: '3' })).toBe(false);
    expect(isPhoneToTv({ t: 'getState', haveVersion: 1.5 })).toBe(false);
    expect(isPhoneToTv({ t: 'ping', at: 1 })).toBe(false);
    expect(isPhoneToTv({ t: 'addSource', input: { kind: 'm3u', name: 'Home' } })).toBe(false);
    expect(isPhoneToTv({ t: 'addSource', input: { kind: 'm3u', id: 'x', name: 'Home', playlistUrl: 'u' } })).toBe(false);
    expect(isPhoneToTv({ t: 'addSource', input: { kind: 'xtream', name: 'X', server: 's', username: 'u' } })).toBe(false);
    expect(isPhoneToTv({ t: 'addSource', input: { kind: 'stalker', name: 'X' } })).toBe(false);
    expect(isPhoneToTv({ t: 'updateSource', source: { kind: 'm3u', name: 'Home', playlistUrl: 'u' } })).toBe(false);
    expect(isPhoneToTv({ t: 'updateSource', source: { kind: 'm3u', id: 'a', name: 'Home', playlistUrl: 'u', epgUrl: 3 } })).toBe(false);
  });
});

describe('isTvToPhone', () => {
  test('accepts every message kind', () => {
    const msgs: TvToPhone[] = [
      { t: 'welcome', tv: { label: 'TV', appVersion: '1.1.0', protocol: 1 } },
      { t: 'state', state: bigState(1) },
      { t: 'state', state: { ...bigState(1), channels: [{ id: 'c', name: 'Same', group: 'g', number: 1, hasEpg: true }] } },
      { t: 'stateUnchanged', version: 3 },
      { t: 'source', source: { kind: 'm3u', id: 'a', name: 'Home', playlistUrl: 'https://media.example.test/l.m3u' } },
      { t: 'layoutChanged', version: 2, layout: emptyLayout() },
      { t: 'progress', phase: 'epg', count: 10 },
      { t: 'result', requestMsgId: 7, ok: true },
      { t: 'result', requestMsgId: 7, ok: false, error: { name: 'Error', message: 'nope' } },
      { t: 'bye' },
    ];
    for (const m of msgs) expect(isTvToPhone(m)).toBe(true);
  });

  test('is forward-compatible: accepts unknown extra fields', () => {
    const msgs: unknown[] = [
      { t: 'welcome', tv: { label: 'TV', appVersion: '1.1.0', protocol: 1, model: 'x' }, extra: 1 },
      { t: 'state', state: { ...bigState(1), future: true }, extra: 'y' },
      { t: 'source', source: { kind: 'm3u', id: 'a', name: 'Home', playlistUrl: 'https://media.example.test/l.m3u', future: 1 } },
      { t: 'source', source: { kind: 'xtream', id: 'a', name: 'X', server: 's', username: 'u', password: 'p', future: 1 } },
      { t: 'layoutChanged', version: 2, layout: emptyLayout(), extra: [] },
      { t: 'progress', phase: 'epg', count: 10, total: 20 },
      { t: 'result', requestMsgId: 7, ok: false, error: { name: 'Error', message: 'nope', code: 3 }, extra: null },
      { t: 'bye', reason: 'later' },
    ];
    for (const m of msgs) expect(isTvToPhone(m)).toBe(true);
  });

  test('rejects malformed messages', () => {
    for (const x of [
      null, {}, { t: 'getState' }, { t: 'welcome', tv: { label: 'TV' } },
      { t: 'state', state: { version: 1 } },
      { t: 'state', state: { ...bigState(1), channels: [{ id: 'c', name: 'n', displayName: 3 }] } },
      { t: 'state', state: { ...bigState(1), channels: [{ id: 'c' }] } },
      { t: 'stateUnchanged' },
      { t: 'stateUnchanged', version: -1 },
      { t: 'layoutChanged', version: '2', layout: emptyLayout() },
      { t: 'progress', phase: 'other', count: 1 },
      { t: 'result', requestMsgId: 1, ok: 'yes' },
      { t: 'result', requestMsgId: 1, ok: false, error: 'boom' },
      { t: 'source', source: { kind: 'm3u', name: 'x' } },
    ]) {
      expect(isTvToPhone(x)).toBe(false);
    }
  });
});
