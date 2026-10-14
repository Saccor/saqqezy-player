import { API_TIMEOUT_MS, SourceService, withTimeout } from '@iptv/core';
import { IdbStorage } from '@iptv/storage';
import { APP_API_METHODS, AppApi, CompanionHost, expose, type AppEvent, type PortLike } from '@iptv/app-api';
import { WebSocketRelayTransport, type WebSocketFactory } from '@iptv/companion-protocol';
import { rawViaDevProxy, unwrapDevProxyResponse } from './net/devProxy.ts';

// All parsing, storage and networking for the UI runs here, off the UI thread.
const storage = new IdbStorage();
// Header timeouts: 15 s by default (player_api.php); core asks for 90 s on playlist and XMLTV downloads, whose
// bodies then fail after 30 s without data (BODY_IDLE_MS) instead of holding the source lock forever.
const service = new SourceService({
  storage,
  fetch: withTimeout(async (url, init) => unwrapDevProxyResponse(await fetch(rawViaDevProxy(url), init)), API_TIMEOUT_MS),
});

// Phone companion. The relay only ever sees ciphertext; never log these URLs (they carry the session id).
const RELAY_URL = ((import.meta.env.VITE_RELAY_URL as string | undefined) || 'ws://127.0.0.1:8787').replace(/\/+$/, '');
const COMPANION_ORIGIN = (import.meta.env.VITE_COMPANION_ORIGIN as string | undefined) || 'http://localhost:5174';
const APP_VERSION = '0.0.0';

let emitter: { emit(type: string, payload: unknown): void } | undefined;
const api = new AppApi({
  service,
  storage,
  emit: (e: AppEvent) => emitter?.emit(e.type, e),
  appVersion: APP_VERSION,
  companion: (appApi, onStatus) => new CompanionHost({
    api: appApi,
    tvLabel: 'TV',
    appVersion: APP_VERSION,
    companionOrigin: COMPANION_ORIGIN,
    onStatus,
    // One long-lived transport per session: it reconnects with backoff (status `reconnecting`) and gives up
    // after about 60 s of failures, on a final relay close code, or at the session deadline.
    openTransport: (id, { deadline }) => new WebSocketRelayTransport({
      url: `${RELAY_URL}/v1/session/${id}/ws?role=tv`,
      WebSocket: WebSocket as unknown as WebSocketFactory,
      deadline,
    }),
  }),
});
emitter = expose(api, self as unknown as PortLike, APP_API_METHODS);
