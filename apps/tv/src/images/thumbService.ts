import { loadThumb, type ThumbDeps, type ThumbFrom } from './thumbLoader.ts';
import type { ThumbMode } from './workerThumbDeps.ts';

export interface ThumbRequest { t: 'load'; id: number; url: string; w: number; h: number; alpha: boolean | null }
export type ThumbReply =
  | { t: 'mode'; mode: ThumbMode }
  | { t: 'ok'; id: number; bitmap: ImageBitmap; premultiplyAlpha: boolean; from: ThumbFrom }
  | { t: 'err'; id: number; message: string }
  | { t: 'copy'; kept: boolean };

/** Limits concurrent loads (network and decode memory in the worker); requests are served in arrival order. */
const MAX_ACTIVE = 6;

/**
 * The thumbnail worker's logic: one `loadThumb` per request, at most `maxActive` at once, first in first out. The
 * finished bitmap is transferred to the UI thread; nothing is decoded or encoded there.
 */
export function createThumbService(opts: {
  mode: ThumbMode; deps: ThumbDeps; post: (msg: ThumbReply, transfer?: Transferable[]) => void; maxActive?: number;
  load?: typeof loadThumb;
}): { handle(msg: ThumbRequest): void } {
  const load = opts.load ?? loadThumb;
  const maxActive = opts.maxActive ?? MAX_ACTIVE;
  const queue: ThumbRequest[] = [];
  let active = 0;
  opts.post({ t: 'mode', mode: opts.mode });

  const next = (): void => {
    while (active < maxActive && queue.length > 0) {
      const r = queue.shift()!;
      active += 1;
      load(r.url, r.w, r.h, r.alpha, opts.deps).then(
        (img) => {
          try {
            opts.post({ t: 'ok', id: r.id, bitmap: img.data, premultiplyAlpha: img.premultiplyAlpha, from: img.from }, [img.data]);
          } catch (e) {
            // Not transferred, so it is still ours to free.
            try { img.data.close(); } catch { /* ignore */ }
            opts.post({ t: 'err', id: r.id, message: (e instanceof Error ? e : new Error('Image failed')).message });
          }
        },
        (err: unknown) => opts.post({ t: 'err', id: r.id, message: (err instanceof Error ? err : new Error('Image failed')).message }),
      ).finally(() => { active -= 1; next(); });
    }
  };

  return {
    handle(msg) {
      if (msg.t !== 'load') return;
      if (opts.mode === 'stock') {
        opts.post({ t: 'err', id: msg.id, message: opts.mode });
        return;
      }
      queue.push(msg);
      next();
    },
  };
}
