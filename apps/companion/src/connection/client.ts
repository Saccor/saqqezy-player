import {
  PING_INTERVAL_MS, PROTOCOL_VERSION, SecureChannel, isTvToPhone, type CompanionState, type PairingSecrets, type PhoneToTv,
  type TvToPhone, type WebSocketFactory,
} from '@iptv/companion-protocol';
import type { Layout, SourceConfig } from '@iptv/core';
import type { ClientInfo } from './pair.ts';
import { PendingRequests, RequestError, type ResultMessage } from './pending.ts';
import { CompanionTransport } from './transport.ts';

/** No `welcome` this long after the socket opened: the TV is gone (the session expired). */
export const WELCOME_TIMEOUT_MS = 10_000;
/** The relay's hard cap for a paired session; the transport gives up then. */
export const SESSION_MAX_MS = 60 * 60_000;
/**
 * A `getState` that timed out (30 s) or got a Busy answer is asked again after these delays, one per retry, so
 * at most GETSTATE_BACKOFF_MS.length retries. After that the TV counts as not answering (`stateStatus`).
 */
export const GETSTATE_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
/**
 * Source work (add, update, delete, set active, refresh) can take minutes while the TV loads a playlist or a
 * guide. Such a request stalls only after this long without any message from the TV (progress included).
 */
export const SOURCE_IDLE_TIMEOUT_MS = 60_000;

export type LinkStatus = 'connecting' | 'online' | 'reconnecting';
/** Whether the TV answers `getState`: 'unanswered' once the retries ran out; 'ok' again on the next state. */
export type StateStatus = 'ok' | 'unanswered';

export interface ClientHandlers {
  welcome(tv: { label: string; appVersion: string; protocol: number }): void;
  state(state: CompanionState): void;
  layout(version: number, layout: Layout): void;
  progress(phase: 'playlist' | 'epg', count: number): void;
  link(status: LinkStatus): void;
  /** The TV stopped (or started again) answering state requests. */
  stateStatus(status: StateStatus): void;
  /** The session is over for good; `reason` maps to copy with `endCopy`. */
  ended(reason: string): void;
}

export interface ClientOptions {
  relayUrl: string;
  client: ClientInfo;
  handlers: ClientHandlers;
  WebSocket?: WebSocketFactory;
  isHidden?: () => boolean;
}

type Mutation = Extract<PhoneToTv, { t: 'addSource' | 'updateSource' | 'deleteSource' | 'setActiveSource' | 'refresh' | 'ops' }>;
const SOURCE_OPS: ReadonlySet<string> = new Set(['addSource', 'updateSource', 'deleteSource', 'setActiveSource', 'refresh']);

/**
 * One paired session with the TV: ONE CompanionTransport and ONE SecureChannel for its whole life (reconnects
 * happen inside the transport). Secrets are held only by the channel, in memory; nothing is persisted.
 *
 * - On start: `hello` (with the device label and PROTOCOL_VERSION) and `getState`. After every reconnect:
 *   `getState{ haveVersion }`.
 * - `ping` every PING_INTERVAL_MS while the link is up (TV presence).
 * - Requests that the TV answers with `result` wait in a PendingRequests map keyed by msgId (rejected on close).
 *   Source operations use an idle timeout (SOURCE_IDLE_TIMEOUT_MS, restarted by every TV message); the others
 *   30 s. `getSource` resolves with the `source` message instead.
 * - `getState` is asked again after a timeout or a Busy answer (GETSTATE_BACKOFF_MS); when that runs out the TV
 *   counts as not answering (`stateStatus('unanswered')`) until a state arrives.
 * - `tvProtocol` (from `welcome`) gates message types newer than protocol 1.
 * - Ends on a final transport close (relay close codes), the channel's peer-errors, the TV's `bye`, or no
 *   `welcome` within WELCOME_TIMEOUT_MS of the first open socket.
 */
export class CompanionClient {
  private readonly transport: CompanionTransport;
  private readonly channel: SecureChannel<PhoneToTv, TvToPhone>;
  private readonly pending = new PendingRequests();
  private readonly handlers: ClientHandlers;
  private readonly hello: PhoneToTv;
  private transportReason: string | undefined;
  private welcomed = false;
  private welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private linkStatus: LinkStatus = 'connecting';
  private haveVersion: number | undefined;
  private protocol: number | undefined;
  /** msgIds of `getState` requests still waiting for state, stateUnchanged or a Busy result. */
  private readonly stateRequests = new Set<number>();
  /** Retries used in the current getState round, and the latest attempt (failures of older ones are ignored). */
  private stateRetries = 0;
  private stateAttempt = 0;
  private stateStatusNow: StateStatus = 'ok';
  private readonly sourceWaiters = new Map<string, Set<(s: SourceConfig) => void>>();
  private ended = false;

  constructor(secrets: PairingSecrets, opts: ClientOptions) {
    this.handlers = opts.handlers;
    this.hello = { t: 'hello', client: { kind: opts.client.kind, label: opts.client.label, protocol: PROTOCOL_VERSION } };
    const relay = opts.relayUrl.replace(/\/+$/, '');
    this.transport = new CompanionTransport({
      url: `${relay}/v1/session/${secrets.sessionIdB64}/ws?role=phone`,
      WebSocket: opts.WebSocket ?? (WebSocket as unknown as WebSocketFactory),
      deadline: Date.now() + SESSION_MAX_MS,
      isHidden: opts.isHidden ?? (() => document.visibilityState === 'hidden'),
    });
    // Subscribed before the channel, so the reason is known when the channel reports its close.
    this.transport.onClose((reason) => {
      this.transportReason = reason;
    });
    this.channel = new SecureChannel<PhoneToTv, TvToPhone>({
      secrets, role: 'phone', transport: this.transport, validate: isTvToPhone,
    });
    this.channel.onMessage((msg) => this.onMessage(msg));
    this.channel.onClose((reason) => {
      if (reason === 'transport') this.end(this.transportReason ?? 'unreachable');
      else if (reason !== 'closed') this.end(reason);
    });
    this.transport.onOpen(() => {
      this.setLink('online');
      if (!this.welcomed && this.welcomeTimer === undefined) {
        this.welcomeTimer = setTimeout(() => {
          if (!this.welcomed) this.finish('no-welcome', false);
        }, WELCOME_TIMEOUT_MS);
      }
    });
    this.transport.onDisconnected(() => this.setLink('reconnecting'));
    // After a reconnect the TV must answer again: if this round of getState runs out, it is not answering.
    this.transport.onReconnected(() => this.getState());
    this.pingTimer = setInterval(() => {
      if (this.linkStatus === 'online') void this.channel.send({ t: 'ping' }).catch(() => {});
    }, PING_INTERVAL_MS);
  }

  /** Says hello and asks for the state. Queued until the socket opens. */
  start(): void {
    void this.channel.send(this.hello).catch(() => {});
    this.getState();
  }

  get link(): LinkStatus {
    return this.linkStatus;
  }

  /** The TV's protocol version from `welcome` (undefined until then). Gate newer message types on it. */
  get tvProtocol(): number | undefined {
    return this.protocol;
  }

  /**
   * Asks for the state, starting a fresh round of retries; with a state in hand, the TV may answer
   * `stateUnchanged`. Also the "Retry" after the TV stopped answering.
   */
  getState(): void {
    if (this.ended) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stateRetries = 0;
    this.sendGetState();
  }

  /**
   * Sends a request the TV answers with `result`. Rejects with RequestError on close, or on timeout: 30 s for
   * layout ops. Source operations do not fail by timeout while the TV works on them: after
   * SOURCE_IDLE_TIMEOUT_MS without any TV message, `onStall` runs once, the state is asked for, and the request
   * keeps waiting for its result (up to STALLED_MAX_MS).
   */
  async request(msg: Mutation, onStall?: () => void): Promise<ResultMessage> {
    const msgId = await this.channel.send(msg);
    if (!SOURCE_OPS.has(msg.t)) return this.pending.add(msgId);
    return this.pending.add(msgId, SOURCE_IDLE_TIMEOUT_MS, {
      onStall: () => {
        if (this.ended) return;
        onStall?.();
        this.getState();
      },
    });
  }

  /**
   * Fetches one source with its credentials (for the edit form). Resolves with the `source` message, or
   * rejects with the TV's error (`result`), a timeout, or close. The caller must drop it when the form closes.
   */
  async getSource(id: string): Promise<SourceConfig> {
    let waiter: ((s: SourceConfig) => void) | undefined;
    const fromSource = new Promise<SourceConfig>((resolve) => {
      waiter = resolve;
      let set = this.sourceWaiters.get(id);
      if (!set) this.sourceWaiters.set(id, (set = new Set()));
      set.add(resolve);
    });
    const unregister = () => {
      const set = this.sourceWaiters.get(id);
      if (set && waiter) {
        set.delete(waiter);
        if (set.size === 0) this.sourceWaiters.delete(id);
      }
    };
    try {
      const msgId = await this.channel.send({ t: 'getSource', id });
      const fromResult = this.pending.add(msgId).then((r): never => {
        throw Object.assign(new Error(r.error?.message ?? 'error'), { name: r.error?.name ?? 'Error' });
      });
      try {
        return await Promise.race([fromSource, fromResult]);
      } finally {
        this.pending.cancel(msgId);
        fromResult.catch(() => {});
      }
    } finally {
      unregister();
    }
  }

  /** The page became visible again: reconnect at once if the link is down, otherwise re-check the state. */
  resumeIfNeeded(): void {
    if (this.ended) return;
    if (this.transport.parked || this.linkStatus === 'reconnecting') {
      this.setLink('reconnecting');
      this.transport.resume();
    } else if (this.welcomed) {
      this.getState();
    }
  }

  /** Leaves: optionally says bye (best effort), then closes. No `ended` callback. */
  close(sayBye: boolean): void {
    if (this.ended) return;
    this.finish(undefined, sayBye);
  }

  // ---- internals ----

  private onMessage(msg: TvToPhone): void {
    if (this.ended) return;
    // Any message is a sign of life: long source requests get their full idle time again.
    this.pending.touch();
    switch (msg.t) {
      case 'welcome':
        this.welcomed = true;
        this.protocol = msg.tv.protocol;
        clearTimeout(this.welcomeTimer);
        this.handlers.welcome(msg.tv);
        return;
      case 'state':
        this.haveVersion = msg.state.version;
        this.stateAnswered();
        this.handlers.state(msg.state);
        return;
      case 'stateUnchanged':
        this.stateAnswered();
        return;
      case 'layoutChanged':
        this.handlers.layout(msg.version, msg.layout);
        return;
      case 'progress':
        this.handlers.progress(msg.phase, msg.count);
        return;
      case 'source': {
        const set = this.sourceWaiters.get(msg.source.id);
        if (set) for (const fn of [...set]) fn(msg.source);
        return;
      }
      case 'result':
        this.pending.resolve(msg);
        return;
      case 'bye':
        this.finish('tv-bye', false);
        return;
    }
  }

  private sendGetState(): void {
    if (this.ended) return;
    const attempt = ++this.stateAttempt;
    const msg: PhoneToTv = this.haveVersion === undefined ? { t: 'getState' } : { t: 'getState', haveVersion: this.haveVersion };
    this.channel.send(msg).then((msgId) => {
      this.stateRequests.add(msgId);
      this.pending.add(msgId).then(
        (r) => this.onStateResult(r, attempt),
        (e: unknown) => {
          this.stateRequests.delete(msgId);
          if (e instanceof RequestError && e.reason === 'timeout') this.stateFailed(attempt);
        },
      );
    }, () => {
      // Not sent: queue full, or parked while reconnecting (the reconnect asks again), or closed.
      if (this.linkStatus === 'online') this.stateFailed(attempt);
    });
  }

  private stateAnswered(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stateRetries = 0;
    for (const id of this.stateRequests) this.pending.cancel(id);
    this.stateRequests.clear();
    this.setStateStatus('ok');
  }

  private onStateResult(r: ResultMessage, attempt: number): void {
    this.stateRequests.delete(r.requestMsgId);
    if (r.ok || this.ended) return;
    if (r.error?.name === 'Busy') this.stateFailed(attempt);
  }

  /** The latest getState got no state (timeout, Busy, not sent): back off and ask again, or give up this round. */
  private stateFailed(attempt: number): void {
    if (this.ended || attempt !== this.stateAttempt || this.retryTimer !== undefined) return;
    const delay = GETSTATE_BACKOFF_MS[this.stateRetries];
    if (delay === undefined) {
      this.setStateStatus('unanswered');
      return;
    }
    this.stateRetries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.sendGetState();
    }, delay);
  }

  /** 'unanswered' is reported after every round that runs out (a Retry round included); 'ok' only on change. */
  private setStateStatus(status: StateStatus): void {
    if (status === 'ok' && this.stateStatusNow === 'ok') return;
    this.stateStatusNow = status;
    this.handlers.stateStatus(status);
  }

  private setLink(status: LinkStatus): void {
    if (this.linkStatus === status) return;
    this.linkStatus = status;
    this.handlers.link(status);
  }

  /** Ends the session: optional bye, close everything, and report `reason` (unless it was our own close). */
  private finish(reason: string | undefined, sayBye: boolean): void {
    if (this.ended) return;
    const channel = this.channel;
    const closeAll = () => channel.close();
    if (sayBye) {
      // Best effort: the frame is handed to an open socket synchronously after sealing; close shortly after.
      channel.send({ t: 'bye' }).then(() => setTimeout(closeAll, 100), closeAll);
    }
    this.end(reason);
    if (!sayBye) closeAll();
  }

  private end(reason: string | undefined): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.welcomeTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.pending.closeAll();
    this.stateRequests.clear();
    this.sourceWaiters.clear();
    if (reason !== undefined) this.handlers.ended(reason);
  }
}

export { RequestError };
