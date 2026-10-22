import { API_TIMEOUT_MS, OpenSubtitlesClient, SourceService, SubtitleService, VodService, fetchMovieHash, withTimeout } from '@iptv/core';
import { IdbStorage } from '@iptv/storage';
import { APP_API_METHODS, AppApi, CompanionHost, expose, type AppEvent, type PortLike } from '@iptv/app-api';
import { WebSocketRelayTransport, type WebSocketFactory } from '@iptv/companion-protocol';
import { rawViaDevProxy, unwrapDevProxyResponse } from './net/devProxy.ts';
import { routedFetch } from './net/routedFetch.ts';
import { tvHeaderSupport } from './net/headerSupport.ts';
import { trendingBaseUrl } from './net/trendingConfig.ts';
import { detectPlatform } from '@iptv/platform';
import { guideBatchFor } from './workerOptions.ts';

// All parsing, storage and networking for the UI runs here, off the UI thread.
const storage = new IdbStorage();
// Header timeouts: 15 s by default (player_api.php); core asks for 90 s on playlist and XMLTV downloads, whose
// bodies then fail after 30 s without data (BODY_IDLE_MS) instead of holding the source lock forever.
// A source's User-Agent and Referer (`FetchInit.sourceHeaders`) ride in the dev proxy URL; production drops them.
const fetchFn = withTimeout(
  routedFetch(async (url, init) => unwrapDevProxyResponse(await fetch(url, init)), rawViaDevProxy),
  API_TIMEOUT_MS,
);
const platform = detectPlatform(self.navigator.userAgent, {});
// TVs write the guide in smaller batches: a Guide read waits behind at most one of them.
const epgBatch = guideBatchFor(platform);
const service = new SourceService({ storage, fetch: fetchFn, ...(epgBatch ? { epgBatch } : {}) });
// Movies and series: same storage, network path and refusal cooldown; catalogues load lazily and one stays resident.
const vod = new VodService({ storage, fetch: fetchFn, guard: service.guard, syncClock: service.syncClock });
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

// Trending rows on Start: a public feed (services/trending) matched against the library on this device. The request
// is a bare GET (no credentials, no referrer, nothing about the user); dev reads the fake provider's synthetic feed.
// Without VITE_TRENDING_URL a production build has no trending rows and never asks.
const TRENDING_URL = trendingBaseUrl({
  VITE_TRENDING_URL: import.meta.env.VITE_TRENDING_URL as string | undefined, DEV: import.meta.env.DEV,
});
/** The feed's own fetch: straight from the device (the feed answers CORS), cut off after API_TIMEOUT_MS. */
const trendingFetch = (url: string, init: RequestInit): Promise<Response> => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
};

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
  // Exact-match subtitles (a Settings choice): two 64 KB range reads of the VOD file over the app's fetch,
  // with the stream's User-Agent and Referer (routed like list requests).
  fileHash: (url, headers) => fetchMovieHash(fetchFn, url, headers),
  ...(TRENDING_URL ? { trending: { baseUrl: TRENDING_URL, fetch: trendingFetch } } : {}),
  emit: (e: AppEvent) => emitter?.emit(e.type, e),
  appVersion: APP_VERSION,
  storageEstimate: () => navigator.storage.estimate(),
  companion: (appApi, onStatus) => new CompanionHost({
    api: appApi,
    tvLabel: 'TV',
    appVersion: APP_VERSION,
    companionOrigin: COMPANION_ORIGIN,
    // What this TV can send of a source's User-Agent and Referer, for the phone's Advanced help (protocol 2).
    // Workers have no `tizen`/`webOS` globals; the user agent names both platforms.
    headerSupport: tvHeaderSupport(platform, import.meta.env.DEV),
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
