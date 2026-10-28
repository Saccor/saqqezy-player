/**
 * The active source's title index for programme search: loaded in the background on the first search, dropped when
 * idle (memory on 1 GB TVs), and rebuilt once per session when the stored record is missing or unreadable.
 */
import type { SourceService, TitleIndexData } from '@iptv/core';
import type { AppEvent } from './types.ts';

/** The loaded title index is dropped this long after the last search (memory on 1 GB TVs). */
const TITLES_IDLE_MS = 2 * 60_000;

export interface TitleIndexControllerDeps {
  service: SourceService;
  emit: (e: AppEvent) => void;
  /** The active source's id. */
  activeId: () => string | undefined;
  /** Runs `fn` on the source's serial queue (AppApi's `enqueue`). */
  enqueue: (id: string, fn: () => Promise<void>) => Promise<void>;
  /** A failure worth a Diagnostics line (name only). */
  note: (message: string) => void;
  /** Records a failure (scrubbed, in diagnostics): AppApi's `record`. */
  record: (where: string, err: unknown) => void;
}

export class TitleIndexController {
  /** The active source's title index, loaded on the first search. */
  private titles: { sourceId: string; data: TitleIndexData } | undefined;
  private titlesTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every index swap, so a title index load that raced a swap is not cached. */
  private titlesEpoch = 0;
  /** Sources whose title index rebuild was already tried this session. */
  private readonly titleRebuilds = new Map<string, 'running' | 'done'>();
  /** The title index load in flight (one per source and epoch; concurrent searches join it). */
  private titleLoad: { sourceId: string; epoch: number } | undefined;
  /** Title index loads in flight (awaited by the test-only `idle`). */
  private readonly titleJobs = new Set<Promise<void>>();
  /** No title index for this source and epoch, and its one rebuild was already tried: channels only, not pending. */
  private titlesMissing: { sourceId: string; epoch: number } | undefined;

  constructor(private readonly deps: TitleIndexControllerDeps) {}

  /** Bumped by every index swap: a search that saw another epoch belongs to an older index. */
  get epoch(): number {
    return this.titlesEpoch;
  }

  /** Title index loads in flight (awaited by the test-only `idle`). */
  get jobs(): ReadonlySet<Promise<void>> {
    return this.titleJobs;
  }

  /** The index was swapped (or the guide changed): forget the loaded title index. */
  drop(): void {
    this.titles = undefined;
    this.titlesEpoch++;
  }

  /** The source was deleted: its rebuild may be tried again if it comes back. */
  forget(id: string): void {
    this.titleRebuilds.delete(id);
  }

  /**
   * The title index of `id` when it is in memory. Otherwise undefined, after starting (or joining) its
   * background load, unless a rebuild is running (it loads the index when done) or the index is known missing.
   */
  cached(id: string): TitleIndexData | undefined {
    if (this.titlesTimer !== undefined) clearTimeout(this.titlesTimer);
    this.titlesTimer = setTimeout(() => { this.titles = undefined; this.titlesTimer = undefined; }, TITLES_IDLE_MS);
    (this.titlesTimer as { unref?: () => void }).unref?.();
    if (this.titles?.sourceId === id) return this.titles.data;
    const missing = this.titlesMissing;
    if (missing?.sourceId === id && missing.epoch === this.titlesEpoch) return undefined;
    if (this.titleRebuilds.get(id) === 'running') return undefined;
    this.load(id);
    return undefined;
  }

  /** True while a title index load or rebuild of `id` is in flight. */
  pending(id: string): boolean {
    return this.titleLoad?.sourceId === id || this.titleRebuilds.get(id) === 'running';
  }

  /**
   * Loads the stored title index of `id` in the background (one load per source and epoch). When it is still
   * current: caches it and emits `searchReady`; with no usable record, starts the one-time rebuild, or, when
   * that was already tried, marks the index missing and emits `searchReady` so the TV drops its pending note.
   */
  private load(id: string): void {
    const epoch = this.titlesEpoch;
    if (this.titleLoad?.sourceId === id && this.titleLoad.epoch === epoch) return;
    const load = { sourceId: id, epoch };
    this.titleLoad = load;
    const job = (async () => {
      let data: TitleIndexData | undefined;
      try {
        data = await this.deps.service.titleIndexFor(id);
      } catch (err) {
        // Never a failed search: logged by error name only, then rebuilt like a missing record.
        this.deps.note(`Title index could not be read (${err instanceof Error ? err.name : 'Error'}).`);
      }
      if (this.titleLoad === load) this.titleLoad = undefined;
      // The source or its guide changed meanwhile: this result belongs to an older index.
      if (this.deps.activeId() !== id || this.titlesEpoch !== epoch) return;
      if (data) {
        this.titles = { sourceId: id, data };
        this.deps.emit({ type: 'searchReady', sourceId: id });
      } else if (!this.titleRebuilds.has(id)) {
        this.startRebuild(id);
      } else if (this.titleRebuilds.get(id) === 'done') {
        this.titlesMissing = { sourceId: id, epoch };
        this.deps.emit({ type: 'searchReady', sourceId: id });
      }
    })().catch((err: unknown) => { this.deps.record('search', err); });
    this.titleJobs.add(job);
    void job.then(() => this.titleJobs.delete(job));
  }

  private startRebuild(id: string): void {
    if (this.titleRebuilds.has(id)) return;
    this.titleRebuilds.set(id, 'running');
    void this.deps.enqueue(id, async () => {
      try {
        await this.deps.service.rebuildTitleIndex(id);
      } catch (err) {
        this.deps.record('rebuildTitleIndex', err);
        if (this.titleRebuilds.has(id)) this.titleRebuilds.set(id, 'done');
        // Not retried this session: searches return channels only, without the pending note. As on the
        // load-missing path, searchReady lets the TV re-run the query and drop its "being prepared" note.
        if (this.deps.activeId() === id) {
          this.titlesMissing = { sourceId: id, epoch: this.titlesEpoch };
          this.deps.emit({ type: 'searchReady', sourceId: id });
        }
        return;
      }
      if (this.titleRebuilds.has(id)) this.titleRebuilds.set(id, 'done');
      // Load the rebuilt index; its load emits `searchReady`.
      if (this.deps.activeId() === id) this.load(id);
    });
  }
}
