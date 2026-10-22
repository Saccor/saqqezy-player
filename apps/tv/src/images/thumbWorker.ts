// Thumbnail worker: fetches, decodes, shrinks and keeps small copies of posters and logos, off the UI thread.
// Started by `images/thumbClient.ts` through Vite's `?worker` import (a classic worker in the build).
import { createThumbService, type ThumbReply, type ThumbRequest } from './thumbService.ts';
import { ThumbStore } from './thumbStore.ts';
import { thumbMode, workerThumbDeps } from './workerThumbDeps.ts';

const scope = self as unknown as {
  postMessage(msg: ThumbReply, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ThumbRequest>) => void) | null;
};
const mode = thumbMode(self as unknown as Record<string, unknown>);
const post = (msg: ThumbReply, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []);
const deps = workerThumbDeps({
  mode,
  store: new ThumbStore(),
  counters: { kept: () => post({ t: 'copy', kept: true }), skipped: () => post({ t: 'copy', kept: false }) },
});
const service = createThumbService({ mode, deps, post });
scope.onmessage = (e) => service.handle(e.data);
