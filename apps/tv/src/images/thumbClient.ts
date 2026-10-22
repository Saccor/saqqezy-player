import type { ThumbReply, ThumbRequest } from './thumbService.ts';
import type { ThumbMode } from './workerThumbDeps.ts';

export interface PortLike { postMessage(msg: ThumbRequest): void; onmessage: ((e: { data: ThumbReply }) => void) | null; onerror?: ((e: unknown) => void) | null }
export interface ThumbStats { stored: number; fetched: number; asIs: number; failed: number; kept: number; skipped: number; mode: ThumbMode | undefined; failedWorker?: boolean }
/** The renderer's image result (renderer 3.7 `TextureData`, the image case). */
export type LoadedImageLike = { data: ImageBitmap; premultiplyAlpha: boolean | null; premultiplied?: boolean };

const START_TIMEOUT_MS = 5000;
export interface ThumbClientOptions {
  startTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * UI side of the thumbnail worker: one request per sized image, answered with a transferred `ImageBitmap`. Nothing
 * here decodes, scales or encodes. In `stock` mode (no worker image support) loads take the renderer's own path.
 */
export class ThumbClient {
  private nextId = 1;
  private readonly waiting = new Map<number, { ok: (r: LoadedImageLike) => void; fail: (e: Error) => void }>();
  private readonly counts: ThumbStats = { stored: 0, fetched: 0, asIs: 0, failed: 0, kept: 0, skipped: 0, mode: undefined };
  private readonly modeReady: Promise<ThumbMode>;
  private setMode!: (m: ThumbMode) => void;

  private readonly clearTimer: (h: unknown) => void;
  private startTimer: unknown;

  constructor(private readonly port: PortLike, opts: ThumbClientOptions = {}) {
    this.modeReady = new Promise((r) => { this.setMode = r; });
    port.onmessage = (e) => this.receive(e.data);
    port.onerror = () => this.workerFailed();
    const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.startTimer = setTimer(() => this.workerFailed(), opts.startTimeoutMs ?? START_TIMEOUT_MS);
  }

  /** The worker did not start or died: images take the renderer's path, and loads in flight fail instead of hanging. */
  private workerFailed(): void {
    if (this.startTimer !== undefined) { this.clearTimer(this.startTimer); this.startTimer = undefined; }
    this.counts.mode = 'stock';
    this.counts.failedWorker = true;
    this.setMode('stock');
    for (const w of this.waiting.values()) {
      this.counts.failed += 1;
      w.fail(new Error('Image worker failed'));
    }
    this.waiting.clear();
  }

  async load(url: string, w: number, h: number, alpha: boolean | null, stock: () => Promise<LoadedImageLike>): Promise<LoadedImageLike> {
    const mode = this.counts.mode ?? await this.modeReady;
    if (mode === 'stock') return stock();
    const id = this.nextId++;
    return new Promise<LoadedImageLike>((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.port.postMessage({ t: 'load', id, url, w, h, alpha });
    });
  }

  stats(): ThumbStats {
    return { ...this.counts };
  }

  private receive(m: ThumbReply): void {
    if (m.t === 'mode') {
      if (this.counts.failedWorker) return;
      if (this.startTimer !== undefined) { this.clearTimer(this.startTimer); this.startTimer = undefined; }
      this.counts.mode = m.mode;
      this.setMode(m.mode);
    } else if (m.t === 'copy') {
      if (m.kept) this.counts.kept += 1; else this.counts.skipped += 1;
    } else if (m.t === 'ok') {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      this.counts[m.from] += 1;
      w?.ok({ data: m.bitmap, premultiplyAlpha: m.premultiplyAlpha, premultiplied: true });
    } else if (m.t === 'err') {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      this.counts.failed += 1;
      w?.fail(new Error(m.message));
    }
  }
}

export function thumbStatsLine(s: ThumbStats): string {
  if (s.mode === undefined) return 'Starting';
  if (s.failedWorker) return 'Renderer loader (worker failed)';
  if (s.mode === 'stock') return 'Renderer loader (no worker support)';
  return `Worker · ${s.stored} from device, ${s.fetched} shrunk, ${s.asIs} as is, ${s.failed} failed`
    + ` · copies kept ${s.kept}, skipped ${s.skipped}`;
}

let client: ThumbClient | undefined;

/** Starts the app's client once (`shell/corsPlatform.ts`); later calls return the same one. */
export function startThumbClient(port: PortLike): ThumbClient {
  client ??= new ThumbClient(port);
  return client;
}

/** The app's counters for Diagnostics; undefined before the first sized image. */
export function thumbStats(): ThumbStats | undefined {
  return client?.stats();
}
