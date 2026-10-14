import { wrap, type AppApi } from '@iptv/app-api';
// `?worker`: Vite starts a module worker in dev and, with `worker.format: 'iife'`, a classic worker in the build.
// Module workers need Chromium 80+, which older Tizen TVs (Chromium 76) do not have.
import CoreWorker from './worker.ts?worker';

/** The single core Worker; every core call from the UI goes over typed RPC. */
const worker = new CoreWorker();

const remote = wrap<AppApi>(worker);

export const api = remote.api;
/** Subscribe to an `AppEvent` type (`progress`, `refreshed`, `refreshFailed`, `offline`). */
export const onEvent = remote.on;
