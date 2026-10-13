import { SourceService, withTimeout } from '@iptv/core';
import { IdbStorage } from '@iptv/storage';
import { APP_API_METHODS, AppApi, expose, type AppEvent, type PortLike } from '@iptv/app-api';
import { rawViaDevProxy, unwrapDevProxyResponse } from './net/devProxy.ts';

// All parsing, storage and networking for the UI runs here, off the UI thread.
const storage = new IdbStorage();
const service = new SourceService({
  storage,
  fetch: withTimeout(async (url, init) => unwrapDevProxyResponse(await fetch(rawViaDevProxy(url), init))),
});

let emitter: { emit(type: string, payload: unknown): void } | undefined;
const api = new AppApi({
  service,
  storage,
  emit: (e: AppEvent) => emitter?.emit(e.type, e),
  appVersion: '0.0.0',
});
emitter = expose(api, self as unknown as PortLike, APP_API_METHODS);
