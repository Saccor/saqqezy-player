import type { NewSource } from '@iptv/core';
import {
  isPhoneToTv, MAX_MESSAGE_BYTES, newPairingCode, newQrSecrets, SecureChannel, secretsFromCode,
  type CompanionState, type FrameTransport, type PairingSecrets, type PhoneToTv, type TvToPhone,
} from '@iptv/companion-protocol';
import { scrub, type AppApi } from './appApi.ts';
import { toRpcError } from './rpc.ts';
import type { AppEvent, CompanionControl, CompanionStartResult, CompanionStatus } from './types.ts';

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
 * - Any final transport close (relay 4000 expired/idle, 4001 replaced, limits, ~60 s unreachable, the
 *   deadline) or channel close ends the session with status `expired`; the pairing screen then offers a new
 *   code. (The dev relay expires unpaired sessions after 60 s, which lands here.)
 *
 * Incoming messages were already strictly validated by `isPhoneToTv` in the channel. Source input is then
 * checked against the same rules as the on-TV form (http/https only, required fields) before AppApi sees it.
 * Errors sent back are AppApi's credential-free errors, scrubbed once more. Nothing here logs anything.
 *
 * Outgoing `state` is fitted under the protocol's 8 MiB message cap by `fitCompanionState`.
 * Progress is forwarded while a companion is connected, at most one per phase every PROGRESS_INTERVAL_MS
 * (the relay allows 200 frames per 10 s). Layout changes are pushed as `layoutChanged`, coalesced.
 * While the transport is reconnecting, pushes are skipped: the phone asks for `getState` after it reconnects.
 */

export const UNPAIRED_TTL_MS = 15 * 60_000;
export const PAIRED_TTL_MS = 60 * 60_000;
/** The `state` message's JSON must fit in this many bytes (the protocol cap minus headroom). */
export const STATE_BUDGET_BYTES = MAX_MESSAGE_BYTES - 64 * 1024;
/** Logos longer than this (e.g. inline `data:` images) are the first thing dropped from an oversized state. */
export const LOGO_MAX_CHARS = 512;
const PROGRESS_INTERVAL_MS = 500;
/** How long `stop()` and expiry wait for the goodbye to be handed to the transport before closing. */
const BYE_GRACE_MS = 1_000;
const DEFAULT_NAME = 'My TV';

export type CompanionHostApi = Pick<
  AppApi,
  'getCompanionState' | 'getSource' | 'getLayout' | 'applyLayoutOps' | 'addSource' | 'updateSource' | 'deleteSource'
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
  /** A companion said hello and has not said bye. */
  connected: boolean;
  peerLabel: string | undefined;
  /** The transport is reconnecting. */
  linkDown: boolean;
  unsub: (() => void)[];
  layoutBusy: boolean;
  layoutDirty: boolean;
  progress: Map<'playlist' | 'epg', { last: number; pending?: number; timer?: ReturnType<typeof setTimeout> }>;
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

export class CompanionHost implements CompanionControl {
  private readonly deps: CompanionHostDeps;
  private readonly now: () => number;
  private readonly unpairedTtl: number;
  private readonly pairedTtl: number;
  private session: Session | undefined;
  /** Status when there is no session. */
  private terminal: 'idle' | 'expired' = 'idle';
  /** Bumped by every start() and stop(), so a start() whose key derivation was overtaken gives up. */
  private ticket = 0;
  private lastEmitted = JSON.stringify({ state: 'idle' });

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
    const channel = new SecureChannel<TvToPhone, PhoneToTv>({ secrets, role: 'tv', transport, validate: isPhoneToTv });
    const s: Session = {
      channel, createdAt, expiresAt: createdAt + this.unpairedTtl, timer: undefined, paired: false, connected: false,
      peerLabel: undefined, linkDown: false, unsub: [], layoutBusy: false, layoutDirty: false, progress: new Map(),
    };
    this.session = s;
    s.unsub.push(channel.onMessage((msg, msgId) => this.handle(s, msg, msgId)));
    s.unsub.push(channel.onClose(() => {
      if (this.session === s) this.end('expired', false);
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
        this.emitStatus();
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
    if (!s) return { state: this.terminal };
    const state = s.linkDown ? 'reconnecting' : s.connected ? 'connected' : 'waiting';
    const out: CompanionStatus = { state, expiresAt: s.expiresAt };
    if (s.connected && s.peerLabel) out.peerLabel = s.peerLabel;
    return out;
  }

  handleEvent(e: AppEvent): void {
    const s = this.session;
    if (!s || !s.connected || s.linkDown) return;
    if (e.type === 'layoutChanged') this.pushLayout(s);
    else if (e.type === 'progress') this.pushProgress(s, e.phase, e.count);
  }

  // ---- internals ----

  /** Ends the current session. With `bye`, the companion is told first (best effort). */
  private end(terminal: 'idle' | 'expired', bye = true, emit = true): void {
    const s = this.session;
    this.terminal = terminal;
    if (!s) {
      if (emit) this.emitStatus();
      return;
    }
    this.session = undefined;
    clearTimeout(s.timer);
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
      if (this.session === s) this.end('expired');
    }, Math.max(0, s.expiresAt - this.now()));
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

  /**
   * Handles one validated message. Handlers start in arrival order and call AppApi synchronously, so AppApi's
   * own locks keep the order of layout batches; long-running source work does not block later messages.
   */
  private handle(s: Session, msg: PhoneToTv, msgId: number): void {
    if (this.session !== s) return;
    if (!s.paired) {
      s.paired = true;
      s.expiresAt = s.createdAt + this.pairedTtl;
      this.schedule(s);
    }
    void this.dispatch(s, msg, msgId).catch((err: unknown) => this.result(s, msgId, err));
  }

  private async dispatch(s: Session, msg: PhoneToTv, msgId: number): Promise<void> {
    const api = this.deps.api;
    switch (msg.t) {
      case 'hello':
        s.connected = true;
        s.peerLabel = msg.client.label.trim() || undefined;
        this.emitStatus();
        await this.send(s, { t: 'welcome', tv: { label: this.deps.tvLabel, appVersion: this.deps.appVersion } });
        return;
      case 'bye':
        s.connected = false;
        s.peerLabel = undefined;
        this.emitStatus();
        return;
      case 'getState': {
        const state = fitCompanionState(await api.getCompanionState());
        await this.send(s, { t: 'state', state });
        return;
      }
      case 'getSource': {
        const source = await api.getSource(msg.id);
        if (!source) throw Object.assign(new Error('Source not found.'), { name: 'NotFoundError' });
        await this.send(s, { t: 'source', source });
        return;
      }
      case 'ops': {
        // Ops are intents (ids, not positions in a snapshot), so they apply to the current layout whatever
        // `baseVersion` the phone saw; `layoutChanged` brings it up to date.
        const res = await api.applyLayoutOps(msg.ops, 'remote');
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
        await api.addSource(checked(msg.input));
        await this.result(s, msgId);
        return;
      case 'updateSource': {
        const { id, ...input } = msg.source;
        await api.updateSource({ ...checked(input as NewSource), id });
        await this.result(s, msgId);
        return;
      }
      case 'deleteSource':
        await api.deleteSource(msg.id);
        await this.result(s, msgId);
        return;
      case 'setActiveSource':
        await api.setActiveSource(msg.id);
        await this.result(s, msgId);
        return;
      case 'refresh':
        await api.refresh(msg.what);
        await this.result(s, msgId);
        return;
    }
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
          const layout = await this.deps.api.getLayout();
          if (this.session !== s || !s.connected) return;
          await this.send(s, { t: 'layoutChanged', version: layout.version, layout });
        } while (s.layoutDirty);
      } catch {
        // The phone can always ask for getState.
      } finally {
        s.layoutBusy = false;
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
 * http/https addresses only, required fields present, names defaulted, the password kept exactly as typed and
 * everything else trimmed. Messages never echo the input.
 */
export function validateSourceInput(input: NewSource): { ok: true; input: NewSource } | { ok: false; message: string } {
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
