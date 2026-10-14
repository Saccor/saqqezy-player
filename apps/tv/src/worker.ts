import { API_TIMEOUT_MS, SourceService, withTimeout } from '@iptv/core';
import { IdbStorage } from '@iptv/storage';
import { APP_API_METHODS, AppApi, expose, type AppEvent, type PortLike } from '@iptv/app-api';
import { rawViaDevProxy, unwrapDevProxyResponse } from './net/devProxy.ts';

// All parsing, storage and networking for the UI runs here, off the UI thread.
const storage = new IdbStorage();
// Header timeouts: 15 s by default (player_api.php); core asks for 90 s on playlist and XMLTV downloads, whose
// bodies then fail after 30 s without data (BODY_IDLE_MS) instead of holding the source lock forever.
const service = new SourceService({
  storage,
  fetch: withTimeout(async (url, init) => unwrapDevProxyResponse(await fetch(rawViaDevProxy(url), init)), API_TIMEOUT_MS),
});

let emitter: { emit(type: string, payload: unknown): void } | undefined;
const api = new AppApi({
  service,
  storage,
  emit: (e: AppEvent) => emitter?.emit(e.type, e),
  appVersion: '0.0.0',
});
emitter = expose(api, self as unknown as PortLike, APP_API_METHODS);
