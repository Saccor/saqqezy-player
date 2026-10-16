import { NAME_MAX, type NewSource } from '@iptv/core';
import {
  ChannelClosedError, isPhoneToTv, isUnknownPhoneMessage, MAX_MESSAGE_BYTES, newPairingCode, newQrSecrets, PROTOCOL_VERSION,
  QueueFullError, SecureChannel, secretsFromCode,
  type CloseReason, type CompanionState, type FrameTransport, type PairingSecrets, type PhoneToTv, type TvToPhone,
} from '@iptv/companion-protocol';
import { scrub, type AppApi } from './appApi.ts';
import { toRpcError } from './rpc.ts';
import type { AppEvent, CompanionControl, CompanionEndReason, CompanionStartResult, CompanionStatus } from './types.ts';

export type { CompanionStartResult, CompanionStatus };

/**
 * The TV side of the phone companion. Runs in the TV's Web Worker next to AppApi.
 *
 * One session at a time. `start()` creates fresh pairing secrets (a QR fragment or a code), opens ONE
 * long-lived relay transport for them and builds ONE SecureChannel over it; reconnects happen inside the
 * transport, so the channel (its msgId counter and replay window) lives for the whole session. Starting
 * again replaces the session; `stop()` says bye and closes. Pairing secrets live only in memory.
 *
 * Lifetimes (the TV enforces its own; the relay's TTLs are best effort):
 * - Unpaired: the session expires UNPAIRED_TTL_MS (15 min) after `start()`.
 * - Paired (any authenticated message arrived): the hard cap is PAIRED_TTL_MS (60 min) from `start()`.
 *   The transport gets the same deadline.
 * - Every incoming message is checked against the expiry too, because TV standby can delay timers.
 * - Any final transport close (relay 4000 expired/idle, 4001 replaced, limits, ~60 s unreachable, the
 *   deadline) or channel close ends the session with status `expired` and a `reason`; the pairing screen then
 *   offers a new code. (The dev relay expires unpaired sessions after 60 s, which lands here.)
 *
 * Peer presence: any authenticated message marks the companion `connected` (label from its last hello;
 * messages before hello are served too). It pings every 25 s; after PEER_TIMEOUT_MS of silence the status goes
 * back to `waiting` and the session continues. `bye` makes it `waiting` at once.
 *
 * Incoming messages were already strictly validated by `isPhoneToTv` in the channel. Source input is then
 * checked against the same rules as the on-TV form (http/https only, required fields) before AppApi sees it.
 * Errors sent back are AppApi's credential-free errors, scrubbed once more. Nothing here logs anything.
 *
 * `getState`:
 * - Single flight: concurrent requests share one build. The fitted (`fitCompanionState`) and serialised
 *   state is cached for the current (layout version, channel-set generation); `layoutChanged`, `refreshed`
 *   and source changes (`stateChanged`) drop it.
 * - `haveVersion` equal to the version this companion last received, with nothing changed since: the answer
 *   is `stateUnchanged`.
 * - A `state` is never stale: if the generation moved while the state was built, it is rebuilt once before
 *   sending. (A companion also ignores a `state` whose `layout.version` is lower than the one it holds.)
 * - Overflow is message-scoped: a state that does not fit the transport's queue, or any request while the
 *   transport is reconnecting, gets `result{ ok: false, error: Busy }` (dropped silently if even that does
 *   not fit). The session goes on; the phone asks again.
 *
 * Progress is forwarded while a companion is connected, at most one per phase every PROGRESS_INTERVAL_MS
 * (the relay allows 200 frames per 10 s). Layout changes are pushed as `layoutChanged` (with the source id the
 * layout belongs to), coalesced; a batch that changed only "recently watched" (a zap) is not pushed. While the
 * transport is reconnecting, pushes are skipped; a layout change in that time is pushed after the reconnect.
 *
 * Source scoping: `ops` carry the source id the companion's layout belongs to. Ops for any other source than the
 * active one are rejected with `result{ ok: false, error: WrongSource }` and change nothing (the phone resyncs).
 *
 * State pushes: when the active source, the source list or the channel set changes (`stateChanged`, from
 * AppApi), a connected companion gets the full `state` without asking, STATE_PUSH_DELAY_MS after the first
 * change of a burst. Pushes are single-flight and coalesced, reuse the cached state, and are skipped when this
 * companion already has the current one. While the link is down the push waits for the reconnect.
 */

export const UNPAIRED_TTL_MS = 15 * 60_000;
export const PAIRED_TTL_MS = 60 * 60_000;
/** A companion that sent nothing for this long counts as gone (it pings every 25 s). */
export const PEER_TIMEOUT_MS = 75_000;
/** The `state` message's JSON must fit in this many bytes (the protocol cap minus headroom). */
export const STATE_BUDGET_BYTES = MAX_MESSAGE_BYTES - 64 * 1024;
/** Logos longer than this (e.g. inline `data:` images) are the first thing dropped from an oversized state. */
export const LOGO_MAX_CHARS = 512;
/** The `result` error for a request the TV cannot answer right now. */
export const BUSY_ERROR = { name: 'Busy', message: 'The TV is busy. Try again.' } as const;
const PROGRESS_INTERVAL_MS = 500;
/** A state push waits this long after the first change of a burst, so related changes go out as one state. */
export const STATE_PUSH_DELAY_MS = 300;
/** How long `stop()` and expiry wait for the goodbye to be handed to the transport before closing. */
const BYE_GRACE_MS = 1_000;
const DEFAULT_NAME = 'My TV';

export type CompanionHostApi = Pick<
  AppApi,
  'getCompanionState' | 'getSource' | 'getActiveLayout' | 'applyLayoutOps' | 'addSource' | 'updateSource' | 'deleteSource'
  | 'setActiveSource' | 'refresh'
>;

/** Optional extras of a relay transport (see `WebSocketRelayTransport`); in-memory test transports may omit them. */
type HostTransport = FrameTransport & {
  onReconnected?(fn: () => void): () => void;
  onDisconnected?(fn: () => void): () => void;
};

export interface CompanionHostDeps {
  api: CompanionHostApi;
  /** Opens the long-lived relay transport for a session; `deadline` is the session's hard end (absolute ms). */
  openTransport: (sessionIdB64: string, opts: { deadline: number }) => FrameTransport;
  tvLabel: string;
  appVersion: string;
  /** Where the companion web app lives; the QR URL is `<origin>/#s=…&k=…`. */
  companionOrigin: string;
  onStatus?: (status: CompanionStatus) => void;
  now?: () => number;
  /** Test hooks. */
  unpairedTtlMs?: number;
  pairedTtlMs?: number;
}

interface Session {
  channel: SecureChannel<TvToPhone, PhoneToTv>;
  createdAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** An authenticated message arrived at least once. */
  paired: boolean;
  /** The companion sent something within PEER_TIMEOUT_MS and has not said bye. */
  connected: boolean;
  /** The label from the companion's last hello. */
  helloLabel: string | undefined;
  presenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The transport is reconnecting. */
  linkDown: boolean;
  unsub: (() => void)[];
  layoutBusy: boolean;
  /** A layout change is still to be pushed (coalesced while a push runs, or held while the link is down). */
  layoutDirty: boolean;
  /** A full state push is running (or due on the timer); `stateDirty`: run it again after this one or the reconnect. */
  stateBusy: boolean;
  stateDirty: boolean;
  stateTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last full state this companion received: its version and generation. */
  sentState: { version: number; generation: number } | undefined;
  progress: Map<'playlist' | 'epg', { last: number; pending?: number; timer?: ReturnType<typeof setTimeout> }>;
}

/** A fitted state ready to send, for one (layout version, generation). */
interface StateEntry {
  generation: number;
  version: number;
  msg: TvToPhone;
  json: string;
}

export class StateTooLargeError extends Error {
  constructor() {
    super('Too many channels to show in the companion.');
    this.name = 'StateTooLargeError';
  }
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const noop = () => { /* ignore */ };

/** Relay transport close reasons (see `TransportCloseReason`) to the status reason. Unknown ones are 'stopped'. */
const TRANSPORT_REASONS: Readonly<Record<string, CompanionEndReason>> = {
  expired: 'expired',
  deadline: 'expired',
  replaced: 'replaced',
  'rate-limit': 'rate-limit',
  quota: 'quota',
  unreachable: 'unreachable',
  'queue-overflow': 'unreachable',
};

function endReason(channelReason: CloseReason, transportReason: string | undefined): CompanionEndReason {
  if (channelReason === 'peer-errors') return 'peer-errors';
  if (channelReason === 'transport' && transportReason !== undefined) {
    return TRANSPORT_REASONS[transportReason] ?? 'stopped';
  }
  return 'stopped';
}

export class CompanionHost implements CompanionControl {
  private readonly deps: CompanionHostDeps;
  private readonly now: () => number;
  private readonly unpairedTtl: number;
  private readonly pairedTtl: number;
  private session: Session | undefined;
  /** Status when there is no session. */
  private terminal: 'idle' | 'expired' = 'idle';
  private terminalReason: CompanionEndReason | undefined;
  /** Bumped by every start() and stop(), so a start() whose key derivation was overtaken gives up. */
  private ticket = 0;
  private lastEmitted = JSON.stringify({ state: 'idle' });
  /** Bumped whenever the companion state may have changed (layout, channels, coverage, sources). */
  private generation = 0;
  private stateCache: StateEntry | undefined;
  private stateBuild: { generation: number; promise: Promise<StateEntry> } | undefined;

  constructor(deps: CompanionHostDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.unpairedTtl = deps.unpairedTtlMs ?? UNPAIRED_TTL_MS;
    this.pairedTtl = deps.pairedTtlMs ?? PAIRED_TTL_MS;
  }

  async start(mode: 'qr' | 'code'): Promise<CompanionStartResult> {
    const ticket = ++this.ticket;
    let secrets: PairingSecrets;
    const out: { qrUrl?: string; code?: string } = {};
    if (mode === 'qr') {
      const qr = await newQrSecrets();
      secrets = qr;
      out.qrUrl = qr.url(this.deps.companionOrigin);
    } else {
      const code = newPairingCode();
      secrets = await secretsFromCode(code);
      out.code = code;
    }
    if (ticket !== this.ticket) throw new Error('Pairing was cancelled.');

    // The old session keeps working until the new one is ready, then is replaced (no `idle` in between).
    this.end('idle', true, false);
    const createdAt = this.now();
    const transport = this.deps.openTransport(secrets.sessionIdB64, { deadline: createdAt + this.pairedTtl }) as HostTransport;
    // Subscribed before the channel, so the transport's reason is known when the channel reports its close.
    let transportReason: string | undefined;
    const unsubTransport = transport.onClose?.((r?: unknown) => {
      transportReason = typeof r === 'string' ? r : undefined;
    });
    const channel = new SecureChannel<TvToPhone, PhoneToTv>({
      secrets, role: 'tv', transport, validate: isPhoneToTv, isUnknown: isUnknownPhoneMessage,
    });
    const s: Session = {
      channel, createdAt, expiresAt: createdAt + this.unpairedTtl, timer: undefined, paired: false, connected: false,
      helloLabel: undefined, presenceTimer: undefined, linkDown: false, unsub: [], layoutBusy: false, layoutDirty: false,
      stateBusy: false, stateDirty: false, stateTimer: undefined, sentState: undefined, progress: new Map(),
    };
    this.session = s;
    if (unsubTransport) s.unsub.push(unsubTransport);
    s.unsub.push(channel.onMessage((msg, msgId) => this.handle(s, msg, msgId)));
    s.unsub.push(channel.onClose((reason) => {
      if (this.session === s) this.end('expired', false, true, endReason(reason, transportReason));
    }));
    if (transport.onDisconnected) {
      s.unsub.push(transport.onDisconnected(() => {
        if (this.session !== s) return;
        s.linkDown = true;
        this.emitStatus();
      }));
    }
    if (transport.onReconnected) {
      s.unsub.push(transport.onReconnected(() => {
        if (this.session !== s) return;
        s.linkDown = false;
        // Its pings could not reach us while the link was down: give it a fresh PEER_TIMEOUT_MS from now.
        if (s.connected) this.touchPeer(s);
        this.emitStatus();
        // A layout change while the link was down was held back: push it now.
        if (s.layoutDirty && s.connected && !s.layoutBusy) this.pushLayout(s);
        if (s.stateDirty && s.connected && !s.stateBusy) this.pushState(s);
      }));
    }
    this.schedule(s);
    this.emitStatus();
    return { ...out, expiresAt: s.expiresAt };
  }

  stop(): void {
    this.ticket++;
    this.end('idle');
  }

  status(): CompanionStatus {
    const s = this.session;
    if (!s) {
      const out: CompanionStatus = { state: this.terminal };
      if (this.terminal === 'expired' && this.terminalReason) out.reason = this.terminalReason;
      return out;
    }
    const state = s.linkDown ? 'reconnecting' : s.connected ? 'connected' : 'waiting';
    const out: CompanionStatus = { state, expiresAt: s.expiresAt };
    if (s.connected && s.helloLabel) out.peerLabel = s.helloLabel;
    return out;
  }

  handleEvent(e: AppEvent): void {
    // A refresh that changed the channels or the guide coverage rebuilds the index, which calls stateChanged().
    if (e.type === 'layoutChanged' || e.type === 'refreshed') this.invalidate();
    const s = this.session;
    if (!s || !s.connected) return;
    if (e.type === 'layoutChanged') {
      // A zap only touched "recently watched", which the companion does not show: no push per channel change.
      if (e.recentOnly) return;
      if (s.linkDown) s.layoutDirty = true; // pushed after the reconnect
      else this.pushLayout(s);
    } else if (e.type === 'progress' && !s.linkDown) {
      this.pushProgress(s, e.phase, e.count);
    }
  }

  /**
   * The active source, the source list, the channels or the guide coverage changed (from AppApi): drops the cached
   * state and pushes the new one to a connected companion (STATE_PUSH_DELAY_MS later, coalesced).
   */
  stateChanged(): void {
    this.invalidate();
    const s = this.session;
    if (!s || !s.connected || s.stateTimer !== undefined) return;
    s.stateTimer = setTimeout(() => {
      s.stateTimer = undefined;
      if (this.session === s && s.connected) this.pushState(s);
    }, STATE_PUSH_DELAY_MS);
  }

  /** Drops the cached state (a new generation). */
  private invalidate(): void {
    this.generation++;
    this.stateCache = undefined;
  }

  // ---- internals ----

  /** Ends the current session. With `bye`, the companion is told first (best effort). */
  private end(terminal: 'idle' | 'expired', bye = true, emit = true, reason?: CompanionEndReason): void {
    const s = this.session;
    this.terminal = terminal;
    this.terminalReason = terminal === 'expired' ? reason : undefined;
    if (!s) {
      if (emit) this.emitStatus();
      return;
    }
    this.session = undefined;
    // The cached state is a full copy of the user's channel list: do not keep it around once nobody can ask.
    this.stateCache = undefined;
    this.stateBuild = undefined;
    clearTimeout(s.timer);
    clearTimeout(s.presenceTimer);
    clearTimeout(s.stateTimer);
    for (const p of s.progress.values()) clearTimeout(p.timer);
    for (const u of s.unsub) u();
    const ch = s.channel;
    if (bye) {
      let done = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        ch.close();
      };
      grace = setTimeout(finish, BYE_GRACE_MS);
      ch.send({ t: 'bye' }).then(finish, finish);
    } else {
      ch.close();
    }
    if (emit) this.emitStatus();
  }

  private schedule(s: Session): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      if (this.session === s) this.end('expired', true, true, 'expired');
    }, Math.max(0, s.expiresAt - this.now()));
  }

  /** The companion is present: (re)starts the PEER_TIMEOUT_MS countdown. */
  private touchPeer(s: Session): void {
    clearTimeout(s.presenceTimer);
    s.presenceTimer = setTimeout(() => {
      if (this.session !== s) return;
      // Its pings cannot reach us while our own link is down: wait for the reconnect.
      if (s.linkDown) {
        this.touchPeer(s);
        return;
      }
      s.connected = false;
      this.emitStatus();
    }, PEER_TIMEOUT_MS);
  }

  private emitStatus(): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    try {
      this.deps.onStatus?.(status);
    } catch {
      // A listener's error must not break the session.
    }
  }

  private send(s: Session, msg: TvToPhone): Promise<void> {
    if (this.session !== s) return Promise.resolve();
    return s.channel.send(msg).then(noop, noop);
  }

  private result(s: Session, requestMsgId: number, err?: unknown): Promise<void> {
    const msg: TvToPhone = { t: 'result', requestMsgId, ok: err === undefined };
    if (err !== undefined) {
      const e = toRpcError(err);
      msg.error = { name: e.name, message: scrub(e.message) };
    }
    return this.send(s, msg);
  }

  /** "Try again": the answer does not fit the transport's queue, or the link is down. Dropped if even this does not fit. */
  private busy(s: Session, requestMsgId: number): Promise<void> {
    return this.send(s, { t: 'result', requestMsgId, ok: false, error: { ...BUSY_ERROR } });
  }

  /**
   * Handles one validated message. Handlers start in arrival order and call AppApi synchronously, so AppApi's
   * own locks keep the order of layout batches; long-running source work does not block later messages.
   */
  private handle(s: Session, msg: PhoneToTv, msgId: number): void {
    if (this.session !== s) return;
    // Timers can be late after TV standby: a message past the expiry ends the session instead.
    if (this.now() >= s.expiresAt) {
      this.end('expired', true, true, 'expired');
      return;
    }
    if (!s.paired) {
      s.paired = true;
      s.expiresAt = s.createdAt + this.pairedTtl;
      this.schedule(s);
    }
    if (msg.t === 'bye') {
      clearTimeout(s.presenceTimer);
      s.connected = false;
      s.helloLabel = undefined;
      this.emitStatus();
      return;
    }
    if (msg.t === 'hello') s.helloLabel = msg.client.label.trim() || undefined;
    s.connected = true;
    this.touchPeer(s);
    this.emitStatus();
    void this.dispatch(s, msg, msgId).catch((err: unknown) => this.result(s, msgId, err));
  }

  private async dispatch(s: Session, msg: Exclude<PhoneToTv, { t: 'bye' }>, msgId: number): Promise<void> {
    const api = this.deps.api;
    switch (msg.t) {
      case 'hello':
        await this.send(s, { t: 'welcome', tv: { label: this.deps.tvLabel, appVersion: this.deps.appVersion, protocol: PROTOCOL_VERSION } });
        return;
      case 'ping':
        return; // presence only; handled above
      case 'getState':
        await this.answerState(s, msgId, msg.haveVersion);
        return;
      case 'getSource': {
        const found = await api.getSource(msg.id);
        if (!found) throw Object.assign(new Error('Source not found.'), { name: 'NotFoundError' });
        // The User-Agent and Referer settings stay on the TV (the phone form has no such fields).
        const { userAgent: _ua, referrer: _ref, ...source } = found;
        await this.send(s, { t: 'source', source });
        return;
      }
      case 'ops': {
        // Ops are intents (ids, not positions in a snapshot), so they apply to the current layout whatever
        // `baseVersion` the phone saw; `layoutChanged` brings it up to date. They must be for the active source:
        // otherwise AppApi throws WrongSource (checked under its lock) and the phone resyncs.
        const res = await api.applyLayoutOps(msg.ops, 'remote', msg.sourceId);
        const first = res.rejected[0];
        if (first) {
          const n = res.rejected.length;
          throw Object.assign(new Error(`${n} change${n === 1 ? ' was' : 's were'} not applied. ${first.reason}`), {
            name: 'LayoutRejected',
          });
        }
        await this.result(s, msgId);
        return;
      }
      case 'addSource':
        await api.addSource(checked(msg.input), 'remote');
        await this.result(s, msgId);
        return;
      case 'updateSource': {
        const { id, ...input } = msg.source;
        // The phone never sees the User-Agent and Referer settings, so its edit keeps the stored ones.
        const stored = await api.getSource(id);
        const keep: { userAgent?: string; referrer?: string } = {};
        if (stored?.userAgent) keep.userAgent = stored.userAgent;
        if (stored?.referrer) keep.referrer = stored.referrer;
        await api.updateSource({ ...checked(input as NewSource), ...keep, id }, 'remote');
        await this.result(s, msgId);
        return;
      }
      case 'deleteSource':
        await api.deleteSource(msg.id, 'remote');
        await this.result(s, msgId);
        return;
      case 'setActiveSource':
        await api.setActiveSource(msg.id, 'remote');
        await this.result(s, msgId);
        return;
      case 'refresh':
        await api.refresh(msg.what);
        await this.result(s, msgId);
        return;
    }
  }

  /** `getState`: `stateUnchanged`, the (cached) state, or Busy when it cannot be sent now. */
  private async answerState(s: Session, msgId: number, haveVersion: number | undefined): Promise<void> {
    if (s.linkDown) {
      await this.busy(s, msgId);
      return;
    }
    let entry = await this.stateEntry();
    if (this.session !== s) return;
    // The state changed while it was being built: rebuild once, so a `state` never overtakes a newer
    // `layoutChanged` that was pushed in the meantime.
    if (entry.generation !== this.generation) {
      entry = await this.stateEntry();
      if (this.session !== s) return;
    }
    const sent = s.sentState;
    if (haveVersion !== undefined && sent !== undefined && sent.version === haveVersion
      && sent.generation === entry.generation && entry.version === haveVersion) {
      await this.send(s, { t: 'stateUnchanged', version: haveVersion });
      return;
    }
    // Never queue a full state behind a dropped link: the phone asks again after its reconnect.
    if (s.linkDown) {
      await this.busy(s, msgId);
      return;
    }
    try {
      await s.channel.send(entry.msg, { json: entry.json });
      s.sentState = { version: entry.version, generation: entry.generation };
    } catch (err) {
      if (err instanceof QueueFullError) await this.busy(s, msgId);
      else if (!(err instanceof ChannelClosedError)) await this.result(s, msgId, err); // scrubbed there
      // ChannelClosedError: the session is ending.
    }
  }

  /** The fitted, serialised state for the current generation: cached, or one build shared by every waiter. */
  private stateEntry(): Promise<StateEntry> {
    const generation = this.generation;
    const cached = this.stateCache;
    if (cached && cached.generation === generation) return Promise.resolve(cached);
    const running = this.stateBuild;
    if (running && running.generation === generation) return running.promise;
    const promise = (async (): Promise<StateEntry> => {
      const state = fitCompanionState(await this.deps.api.getCompanionState());
      const msg: TvToPhone = { t: 'state', state };
      const entry: StateEntry = { generation, version: state.version, msg, json: JSON.stringify(msg) };
      if (this.generation === generation && this.session) this.stateCache = entry;
      return entry;
    })();
    const build = { generation, promise };
    this.stateBuild = build;
    const clear = () => {
      if (this.stateBuild === build) this.stateBuild = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** Sends the current layout; changes that land while a push is in flight are coalesced into one more push. */
  private pushLayout(s: Session): void {
    if (s.layoutBusy) {
      s.layoutDirty = true;
      return;
    }
    s.layoutBusy = true;
    void (async () => {
      try {
        do {
          s.layoutDirty = false;
          const { sourceId, layout } = await this.deps.api.getActiveLayout();
          if (this.session !== s || !s.connected) return;
          if (s.linkDown) {
            s.layoutDirty = true; // pushed after the reconnect
            return;
          }
          // Without an active source there is no layout to show; the state push says so.
          if (sourceId !== undefined) await this.send(s, { t: 'layoutChanged', sourceId, version: layout.version, layout });
        } while (s.layoutDirty && !s.linkDown);
      } catch {
        // The phone can always ask for getState.
      } finally {
        s.layoutBusy = false;
      }
    })();
  }

  /**
   * Pushes the current full state (single flight; changes during a push are coalesced into one more). Skipped when
   * this companion already has it; held while the link is down (pushed after the reconnect). Failures are ignored:
   * the companion can always ask with `getState`.
   */
  private pushState(s: Session): void {
    if (s.stateBusy) {
      s.stateDirty = true;
      return;
    }
    s.stateBusy = true;
    void (async () => {
      try {
        do {
          s.stateDirty = false;
          if (this.session !== s || !s.connected) return;
          if (s.linkDown) {
            s.stateDirty = true; // pushed after the reconnect
            return;
          }
          let entry = await this.stateEntry();
          if (this.session !== s) return;
          // Changed while it was built: rebuild once, so the push is never older than a `layoutChanged` already sent.
          if (entry.generation !== this.generation) {
            entry = await this.stateEntry();
            if (this.session !== s) return;
          }
          const sent = s.sentState;
          if (sent && sent.version === entry.version && sent.generation === entry.generation) continue;
          if (!s.connected) return;
          if (s.linkDown) {
            s.stateDirty = true;
            return;
          }
          try {
            await s.channel.send(entry.msg, { json: entry.json });
            s.sentState = { version: entry.version, generation: entry.generation };
          } catch {
            // Queue full or closing: the companion asks again when it needs the state.
          }
        } while (s.stateDirty && !s.linkDown);
      } catch {
        // A failed build (e.g. too large): the companion's own getState gets the error.
      } finally {
        s.stateBusy = false;
      }
    })();
  }

  /** At most one progress message per phase per PROGRESS_INTERVAL_MS; the latest count is sent at the end of a gap. */
  private pushProgress(s: Session, phase: 'playlist' | 'epg', count: number): void {
    let p = s.progress.get(phase);
    if (!p) {
      p = { last: -Infinity };
      s.progress.set(phase, p);
    }
    const now = this.now();
    if (now - p.last >= PROGRESS_INTERVAL_MS && p.timer === undefined) {
      p.last = now;
      void this.send(s, { t: 'progress', phase, count });
      return;
    }
    p.pending = count;
    if (p.timer !== undefined) return;
    const entry = p;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      const pending = entry.pending;
      entry.pending = undefined;
      if (pending === undefined || this.session !== s || !s.connected || s.linkDown) return;
      entry.last = this.now();
      void this.send(s, { t: 'progress', phase, count: pending });
    }, Math.max(0, PROGRESS_INTERVAL_MS - (now - p.last)));
  }
}

function checked(input: NewSource): NewSource {
  const v = validateSourceInput(input);
  if (!v.ok) throw new ValidationError(v.message);
  return v.input;
}

function isHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
}

/**
 * The on-TV Add source form's rules (apps/tv `validateXtream` / `validateM3u`), applied to companion input:
 * names of at most NAME_MAX characters, http/https addresses only, required fields present, names defaulted, the password kept exactly as typed and
 * everything else trimmed. Messages never echo the input.
 */
export function validateSourceInput(input: NewSource): { ok: true; input: NewSource } | { ok: false; message: string } {
  if (input.name.trim().length > NAME_MAX) return { ok: false, message: `Use a name of ${NAME_MAX} characters or fewer.` };
  const name = input.name.trim() || DEFAULT_NAME;
  if (input.kind === 'xtream') {
    const server = input.server.trim();
    const username = input.username.trim();
    if (!server) return { ok: false, message: 'Enter the server address.' };
    if (!isHttpUrl(server)) return { ok: false, message: 'Enter a server address starting with http:// or https://.' };
    if (!username) return { ok: false, message: 'Enter your username.' };
    if (!input.password) return { ok: false, message: 'Enter your password.' };
    return { ok: true, input: { kind: 'xtream', name, server, username, password: input.password } };
  }
  const playlistUrl = input.playlistUrl.trim();
  const epgUrl = (input.epgUrl ?? '').trim();
  if (!playlistUrl) return { ok: false, message: 'Enter the playlist URL.' };
  if (!isHttpUrl(playlistUrl)) return { ok: false, message: 'Enter a playlist URL starting with http:// or https://.' };
  if (epgUrl && !isHttpUrl(epgUrl)) {
    return { ok: false, message: 'Enter a TV guide URL starting with http:// or https://, or leave it empty.' };
  }
  const out: NewSource = { kind: 'm3u', name, playlistUrl };
  if (epgUrl) out.epgUrl = epgUrl;
  return { ok: true, input: out };
}

/**
 * Fits a companion state under the protocol's message cap (STATE_BUDGET_BYTES of JSON for the whole
 * `state` message; the cap applies before compression). The simplest robust policy, in order:
 * 1. Unchanged when it fits (the common case).
 * 2. Without logos longer than LOGO_MAX_CHARS (inline `data:` images and the like).
 * 3. Without any logos. Every channel is still there; the companion shows them without pictures.
 * 4. Otherwise throws StateTooLargeError (the phone gets a failed `result`). At about 125 bytes per channel
 *    without a logo, that takes well over 60k channels with long names.
 * Channels are never dropped or paged, so the companion's view stays complete when it gets one.
 */
export function fitCompanionState(state: CompanionState): CompanionState {
  if (stateBytes(state) <= STATE_BUDGET_BYTES) return state;
  const strip = (keep: (logo: string) => boolean): CompanionState => ({
    ...state,
    channels: state.channels.map((c) => {
      if (c.logo === undefined || keep(c.logo)) return c;
      const { logo: _drop, ...rest } = c;
      return rest;
    }),
  });
  const shortLogos = strip((logo) => logo.length <= LOGO_MAX_CHARS);
  if (stateBytes(shortLogos) <= STATE_BUDGET_BYTES) return shortLogos;
  const noLogos = strip(() => false);
  if (stateBytes(noLogos) <= STATE_BUDGET_BYTES) return noLogos;
  throw new StateTooLargeError();
}

const encoder = new TextEncoder();

function stateBytes(state: CompanionState): number {
  return encoder.encode(JSON.stringify({ t: 'state', state })).length;
}
