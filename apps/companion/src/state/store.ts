import { createStore, reconcile } from 'solid-js/store';
import type { CompanionState, PairingSecrets } from '@iptv/companion-protocol';
import { CompanionClient, type LinkStatus } from '../connection/client.ts';
import { detectClient } from '../connection/pair.ts';
import { COPY, endCopy } from '../logic/copy.ts';

export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) || 'ws://127.0.0.1:8787';

export type Phase = 'pair' | 'connecting' | 'connected' | 'ended';

export interface AppState {
  phase: Phase;
  link: LinkStatus;
  tvLabel: string | undefined;
  /** The TV's companion state; `state.version` is the layout version this copy reflects. */
  state: CompanionState | undefined;
  progress: { phase: 'playlist' | 'epg'; count: number } | undefined;
  /** Why the last session ended (copy), shown on the Pair page. */
  endMessage: string | undefined;
  /** A short-lived notice (e.g. busy). */
  notice: string | undefined;
}

const [store, setStore] = createStore<AppState>({
  phase: 'pair',
  link: 'connecting',
  tvLabel: undefined,
  state: undefined,
  progress: undefined,
  endMessage: undefined,
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

/** Starts a session with freshly derived secrets. Any previous session is closed first. */
export function connect(secrets: PairingSecrets): void {
  client?.close(true);
  setStore({ phase: 'connecting', link: 'connecting', tvLabel: undefined, state: undefined, progress: undefined, endMessage: undefined });
  const c: CompanionClient = new CompanionClient(secrets, {
    relayUrl: RELAY_URL,
    client: detectClient(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    handlers: {
      welcome: (tv) => {
        if (client !== c) return;
        setStore({ tvLabel: tv.label, phase: 'connected' });
      },
      state: (state) => {
        if (client !== c) return;
        setStore('state', reconcile(state, { key: 'id' }));
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
      notice: () => {
        if (client !== c) return;
        showNotice(COPY.busy);
      },
      ended: (reason) => {
        if (client !== c) return;
        client = undefined;
        setStore({ phase: 'ended', endMessage: endCopy(reason), state: undefined, progress: undefined });
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

/** The page is going away: tell the TV (best effort). */
export function onPageHide(): void {
  if (!client) return;
  client.close(true);
  client = undefined;
  // Restored from the back/forward cache: the session is gone, so offer pairing again.
  setStore({ phase: 'ended', endMessage: COPY.expired, state: undefined, progress: undefined });
}
