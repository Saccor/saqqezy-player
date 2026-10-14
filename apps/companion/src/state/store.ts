import { createStore, reconcile } from 'solid-js/store';
import type { CompanionState, PairingSecrets } from '@iptv/companion-protocol';
import { CompanionClient, type LinkStatus } from '../connection/client.ts';
import { detectClient } from '../connection/pair.ts';
import { COPY, endCopy } from '../logic/copy.ts';

export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) || 'ws://127.0.0.1:8787';

export type Phase = 'pair' | 'connecting' | 'connected' | 'ended';

/** Source work running on the TV, keyed by source id ('add' for a new source). */
export type WorkOp = 'add' | 'update' | 'delete' | 'setActive' | 'refresh';
export interface Work {
  op: WorkOp;
  /** No sign of life from the TV for SOURCE_IDLE_TIMEOUT_MS; cleared by the result or the next state. */
  stalled: boolean;
}

export interface AppState {
  phase: Phase;
  link: LinkStatus;
  tvLabel: string | undefined;
  /** The TV's protocol version (from `welcome`); gate newer message types on it. */
  tvProtocol: number | undefined;
  /** The TV's companion state; `state.version` is the layout version this copy reflects. */
  state: CompanionState | undefined;
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
  tvProtocol: undefined,
  state: undefined,
  stateStatus: 'ok',
  progress: undefined,
  working: {},
  endMessage: undefined,
  pairError: undefined,
  notice: undefined,
});

export { store };

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
    phase: 'ended', endMessage, state: undefined, progress: undefined, stateStatus: 'ok', tvLabel: undefined, tvProtocol: undefined,
  });
  setStore('working', reconcile({}));
}

/** Starts a session with freshly derived secrets. Any previous session is closed first. Throws if it cannot start. */
export function connect(secrets: PairingSecrets): void {
  client?.close(true);
  client = undefined;
  setStore({
    phase: 'connecting', link: 'connecting', tvLabel: undefined, tvProtocol: undefined, state: undefined, progress: undefined,
    endMessage: undefined, pairError: undefined, stateStatus: 'ok',
  });
  setStore('working', reconcile({}));
  const c: CompanionClient = new CompanionClient(secrets, {
    relayUrl: RELAY_URL,
    client: detectClient(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    handlers: {
      welcome: (tv) => {
        if (client !== c) return;
        setStore({ tvLabel: tv.label, tvProtocol: tv.protocol, phase: 'connected' });
      },
      state: (state) => {
        if (client !== c) return;
        // A `layoutChanged` that overtook this state is newer: ignore the older state.
        if (store.state && state.layout.version < store.state.layout.version) return;
        setStore('state', reconcile(state, { key: 'id' }));
        // The state is the truth now: stalled work no longer needs its marker.
        for (const [key, w] of Object.entries(store.working)) if (w?.stalled) setWork(key, undefined);
      },
      layout: (version, layout) => {
        if (client !== c || !store.state) return;
        setStore('state', 'layout', reconcile(layout));
        setStore('state', 'version', version);
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
    },
  });
  client = c;
  c.start();
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
