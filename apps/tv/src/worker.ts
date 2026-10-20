import { API_TIMEOUT_MS, OpenSubtitlesClient, SourceService, SubtitleService, VodService, fetchMovieHash, withTimeout } from '@iptv/core';
import { IdbStorage } from '@iptv/storage';
import { APP_API_METHODS, AppApi, CompanionHost, expose, type AppEvent, type PortLike } from '@iptv/app-api';
import { WebSocketRelayTransport, type WebSocketFactory } from '@iptv/companion-protocol';
import { rawViaDevProxy, unwrapDevProxyResponse } from './net/devProxy.ts';
import { routedFetch } from './net/routedFetch.ts';

// All parsing, storage and networking for the UI runs here, off the UI thread.
const storage = new IdbStorage();
// Header timeouts: 15 s by default (player_api.php); core asks for 90 s on playlist and XMLTV downloads, whose
// bodies then fail after 30 s without data (BODY_IDLE_MS) instead of holding the source lock forever.
// A source's User-Agent and Referer (`FetchInit.sourceHeaders`) ride in the dev proxy URL; production drops them.
const fetchFn = withTimeout(
  routedFetch(async (url, init) => unwrapDevProxyResponse(await fetch(url, init)), rawViaDevProxy),
  API_TIMEOUT_MS,
);
const service = new SourceService({ storage, fetch: fetchFn });
// Movies and series: same storage, network path and refusal cooldown; catalogues load lazily and one stays resident.
const vod = new VodService({ storage, fetch: fetchFn, guard: service.guard });
// Subtitles the user loads from a link or a file: fetched and kept on this device only.
const subtitles = new SubtitleService({ storage, fetch: fetchFn });
// Subtitles found online (OpenSubtitles.com), straight from the device. The app's key comes from
// apps/tv/.env.local (git-ignored); without it "Find subtitles online" is not offered. VITE_OPENSUBTITLES_URL
// points at another server with the same API (the fake provider's: http://127.0.0.1:8899/opensubtitles/api/v1).
const OPENSUBTITLES_KEY = ((import.meta.env.VITE_OPENSUBTITLES_API_KEY as string | undefined) ?? '').trim();
const OPENSUBTITLES_URL = ((import.meta.env.VITE_OPENSUBTITLES_URL as string | undefined) ?? '').trim();
const onlineSubtitles = OPENSUBTITLES_KEY
  ? new OpenSubtitlesClient({
    // The API answers CORS itself, and the dev proxy forwards GET only (download links are POST).
    apiFetch: withTimeout((url, init) => fetch(url, init), API_TIMEOUT_MS),
    fileFetch: fetchFn,
    apiKey: OPENSUBTITLES_KEY,
    ...(OPENSUBTITLES_URL ? { baseUrl: OPENSUBTITLES_URL } : {}),
    appName: 'SaqqezyPlayer v0.0.0',
  })
  : undefined;

// Phone companion. The relay only ever sees ciphertext; never log these URLs (they carry the session id).
const RELAY_URL = ((import.meta.env.VITE_RELAY_URL as string | undefined) || 'ws://127.0.0.1:8787').replace(/\/+$/, '');
const COMPANION_ORIGIN = (import.meta.env.VITE_COMPANION_ORIGIN as string | undefined) || 'http://localhost:5174';
const APP_VERSION = '0.0.0';

let emitter: { emit(type: string, payload: unknown): void } | undefined;
const api = new AppApi({
  service,
  storage,
  vod,
  subtitles,
  onlineSubtitles,
  // Exact-match subtitles (a Settings choice): two 64 KB range reads of the VOD file over the app's fetch.
  fileHash: (url) => fetchMovieHash(fetchFn, url),
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
