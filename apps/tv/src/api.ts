import { wrap, type AppApi } from '@iptv/app-api';

/** The single core Worker; every core call from the UI goes over typed RPC. */
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

const remote = wrap<AppApi>(worker);

export const api = remote.api;
/** Subscribe to an `AppEvent` type (`progress`, `refreshed`, `refreshFailed`, `offline`). */
export const onEvent = remote.on;
