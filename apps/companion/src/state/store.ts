import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { CompanionChannel, CompanionState, PairingSecrets, TvHeaderSupport } from '@iptv/companion-protocol';
import { readTvHeaders } from '../logic/source.ts';
import type { Layout } from '@iptv/core';
import { CompanionClient, type LinkStatus } from '../connection/client.ts';
import { detectClient } from '../connection/pair.ts';
import { COPY, endCopy } from '../logic/copy.ts';
import { OptimisticLayout } from '../logic/optimistic.ts';
import { keepBackup } from './backupStore.ts';

export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) || 'ws://127.0.0.1:8787';

export type Phase = 'pair' | 'connecting' | 'connected' | 'ended';

/** What the store keeps of a `state`: everything but the channels (see `channels`). */
export type HeldState = Omit<CompanionState, 'channels'>;

/** Source work running on the TV, keyed by source id ('add' for a new source). */
export type WorkOp = 'add' | 'update' | 'delete' | 'setActive' | 'refresh';
export interface Work {
  op: WorkOp;
  /** No sign of life from the TV for SOURCE_IDLE_TIMEOUT_MS; cleared by the result or the next state. */
  stalled: boolean;
  /** The request that set this marker: only that request may update or clear it (see `nextWorkToken`). */
  token: number;
}

let workSeq = 0;
/** A fresh token for one request's working marker, so a stale request finishing cannot clear a newer marker. */
export function nextWorkToken(): number {
  return ++workSeq;
}

export interface AppState {
  phase: Phase;
  link: LinkStatus;
  tvLabel: string | undefined;
  /** The TV's protocol version (from `welcome`); gate newer message types on it. */
  tvProtocol: number | undefined;
  /** Which source headers the TV can send (`welcome.tv.headers`, protocol 2); undefined when it did not say. */
  tvHeaders: TvHeaderSupport | undefined;
  /**
   * The TV's companion state without its channel list; `state.version` is the layout version this copy reflects.
   * The channels (up to 50k+) live in the `channels` signal: replaced whole, never proxied or reconciled.
   */
  state: HeldState | undefined;
  /** 'unanswered': getState ran out of retries; 'retrying': the user pressed Retry. */
  stateStatus: 'ok' | 'unanswered' | 'retrying';
  progress: { phase: 'playlist' | 'epg'; count: number } | undefined;
  /** Source requests still running on the TV. */
  working: Record<string, Work | undefined>;
  /** Why the last session ended (copy), shown on the Pair page. */
  endMessage: string | undefined;
  /** A pairing or connect problem (copy), shown on the Pair page or above the shell's content. */
  pairError: string | undefined;
  /** A short-lived notice (e.g. busy). */
  notice: string | undefined;
}

const [store, setStore] = createStore<AppState>({
  phase: 'pair',
  link: 'connecting',
  tvLabel: undefined,
  tvProtocol: undefined, tvHeaders: undefined,
  state: undefined,
  stateStatus: 'ok',
  progress: undefined,
  working: {},
  endMessage: undefined,
  pairError: undefined,
  notice: undefined,
});

export { store };

/**
 * The layout the pages show: the TV's last layout with the changes still on their way applied on top
 * (`OptimisticLayout`). Plain signals, not store state: layouts and the channel list are replaced whole, never
 * proxied or mutated, and big derived views (groups, the picker's search keys) are memoised on their identity.
 */
export const optimistic = new OptimisticLayout();
const [layout, setLayout] = createSignal<Layout | undefined>(undefined);
/** Every channel of the active source from the last full state (replaced whole on each state). */
const [channels, setChannels] = createSignal<readonly CompanionChannel[]>([]);
export { channels, layout };

/** Re-publishes the optimistic view after a change to it. */
export function publishLayout(): void {
  setLayout(() => optimistic.view());
}

/** Dev only: when the last `ops` went out (Date.now(), comparable across tabs), for the latency log. */
let lastOpsSentAt: number | undefined;
export function markOpsSent(): void {
  lastOpsSentAt = Date.now();
}

/** The live session. Memory only: a reload means pairing again. */
let client: CompanionClient | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
/** Progress lines disappear this long after the last progress message (the TV sends no "done"). */
const PROGRESS_IDLE_MS = 4000;

export function currentClient(): CompanionClient | undefined {
  return client;
}

export function showNotice(text: string): void {
  clearTimeout(noticeTimer);
  setStore('notice', text);
  noticeTimer = setTimeout(() => setStore('notice', undefined), 5000);
}

export function clearProgress(): void {
  clearTimeout(progressTimer);
  setStore('progress', undefined);
}

export function setPairError(text: string | undefined): void {
  setStore('pairError', text);
}

export function setWork(key: string, work: Work | undefined): void {
  setStore('working', key, work);
}

/** "Retry" after the TV stopped answering: a fresh round of state requests. */
export function retryState(): void {
  if (!client) return;
  setStore('stateStatus', 'retrying');
  client.getState();
}

/** Everything that belonged to the session (state, work, notices) goes with it. */
function sessionGone(endMessage: string): void {
  client = undefined;
  clearTimeout(progressTimer);
  setStore({
    phase: 'ended', endMessage, state: undefined, progress: undefined, stateStatus: 'ok', tvLabel: undefined, tvProtocol: undefined, tvHeaders: undefined,
  });
  optimistic.reset();
  publishLayout();
  setChannels([]);
  setStore('working', reconcile({}));
}

/** Starts a session with freshly derived secrets. Any previous session is closed first. Throws if it cannot start. */
export function connect(secrets: PairingSecrets): void {
  client?.close(true);
  client = undefined;
  setStore({
    phase: 'connecting', link: 'connecting', tvLabel: undefined, tvProtocol: undefined, tvHeaders: undefined, state: undefined, progress: undefined,
    endMessage: undefined, pairError: undefined, stateStatus: 'ok',
  });
  setStore('working', reconcile({}));
  optimistic.reset();
  publishLayout();
  setChannels([]);
  let c: CompanionClient;
  try {
    c = makeClient(secrets);
  } catch (e) {
    // Nothing started: back to pairing (the caller shows the error).
    setStore({ phase: 'pair' });
    throw e;
  }
  client = c;
  c.start();
}

function makeClient(secrets: PairingSecrets): CompanionClient {
  const c: CompanionClient = new CompanionClient(secrets, {
    relayUrl: RELAY_URL,
    client: detectClient(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    handlers: {
      welcome: (tv) => {
        if (client !== c) return;
        setStore({ tvLabel: tv.label, tvProtocol: tv.protocol, tvHeaders: readTvHeaders(tv.headers), phase: 'connected' });
      },
      state: (state) => {
        if (client !== c) return;
        // Layout versions count per source. For the same source, a `layoutChanged` that overtook this state is
        // newer: ignore the older state. Another active source (switched on the TV or here) always wins, and
        // changes still on their way belonged to the old source's layout.
        const sameSource = store.state !== undefined && store.state.activeSourceId === state.activeSourceId;
        if (sameSource && state.layout.version < store.state!.layout.version) return;
        if (store.state && !sameSource) optimistic.reset();
        // The optimistic layer gets its own copy: store state is proxied and reconciled in place.
        optimistic.confirm(structuredClone(state.layout));
        const { channels: list, ...held } = state;
        setChannels(list.slice());
        setStore('state', reconcile(held, { key: 'id' }));
        publishLayout();
        // The state is the truth now: stalled work no longer needs its marker.
        for (const [key, w] of Object.entries(store.working)) if (w?.stalled) setWork(key, undefined);
      },
      layout: (version, next, sourceId) => {
        if (client !== c || !store.state) return;
        if (sourceId !== store.state.activeSourceId) {
          // A layout of another source than the one held: the TV switched source (or this copy is behind).
          // Versions count per source, so it cannot be compared: ask for the state, which says which is active.
          c.getState();
          return;
        }
        if (next.version < store.state.layout.version) {
          // Overtaken by a newer layout of the same source: ask for the state (`stateUnchanged` when nothing changed).
          c.getState();
          return;
        }
        if (import.meta.env.DEV) {
          const now = Date.now();
          const since = lastOpsSentAt === undefined ? '' : ` (${now - lastOpsSentAt} ms after the last ops were sent)`;
          console.info(`[companion] layoutChanged v${version} at ${now}${since}`);
        }
        optimistic.confirm(structuredClone(next));
        setStore('state', 'layout', reconcile(next));
        setStore('state', 'version', version);
        publishLayout();
      },
      progress: (phase, count) => {
        if (client !== c) return;
        setStore('progress', { phase, count });
        clearTimeout(progressTimer);
        progressTimer = setTimeout(() => setStore('progress', undefined), PROGRESS_IDLE_MS);
      },
      link: (status) => {
        if (client !== c) return;
        setStore('link', status);
      },
      stateStatus: (status) => {
        if (client !== c) return;
        setStore('stateStatus', status);
      },
      ended: (reason) => {
        if (client !== c) return;
        sessionGone(endCopy(reason));
      },
      backup: (backup, tv) => {
        if (client !== c) return;
        // Only a stored backup is confirmed: without `backupSaved` the TV tells the user it was not kept.
        keepBackup(backup, tv).then(
          () => {
            c.backupSaved(backup.at);
            showNotice(`Backup from ${tv || 'your TV'} saved on this phone. Find it under Backup.`);
          },
          () => showNotice("Couldn't keep the backup on this phone. Check that this browser may store data for this page."),
        );
      },
    },
  });
  return c;
}

/** Page visible again: reconnect now if the link is down. */
export function onVisible(): void {
  client?.resumeIfNeeded();
}

/** The page is going away: tell the TV (best effort) and forget the session. */
export function onPageHide(): void {
  if (!client) return;
  client.close(true);
  // If the page comes back from the back/forward cache, the session is gone: offer pairing again.
  sessionGone(COPY.sessionEnded);
}
