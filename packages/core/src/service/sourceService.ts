import { EpgMatcher, epgKey, inWindow, nowNext } from '../epg/window.ts';
import { SourceAuthError, SourceNetworkError, SourceRefusedError } from '../errors.ts';
import { sanitizeSettings, type AppSettings } from '../settings.ts';
import { ChannelIndex } from '../index/channelIndex.ts';
import { isUserFlags, layoutFromFlags } from '../layout/migrate.ts';
import { normalizeLayout } from '../layout/ops.ts';
import { emptyLayout, type Layout } from '../layout/types.ts';
import { parseM3u, type M3uEntry, type ParseStats } from '../m3u/parse.ts';
import { m3uEntriesToChannels } from '../m3u/toChannels.ts';
import { splitM3uVod } from '../m3u/vodSplit.ts';
import { TitleIndexBuilder, isTitleIndexData, type TitleIndexData } from '../search/titleIndex.ts';
import { SportsIndexBuilder, isSportsIndexRecord, type SportsIndexRecord } from '../sports/index.ts';
import { sourceHeadersOf, withCleanHttpSettings } from '../net/headers.ts';
import { REFUSAL_STATUSES, RefusalGuard } from '../net/refusalGuard.ts';
import { responseText } from '../net/textStream.ts';
import { BODY_IDLE_MS, DOWNLOAD_TIMEOUT_MS } from '../net/timeout.ts';
import type { Storage } from '../storage.ts';
import { splitLines } from '../text/lines.ts';
import { emptyVodList } from '../vod/list.ts';
import type { VodKind, VodList } from '../vod/types.ts';
import type {
  Channel, FetchFn, M3uSourceConfig, Programme, SourceConfig, XtreamSourceConfig,
} from '../types.ts';
import { parseXmltv, type XmltvStats } from '../xmltv/parse.ts';
import { UNEXPECTED_RESPONSE, XtreamClient, normalizeServer, type XtreamAccount } from '../xtream/client.ts';
import { xtreamToChannels } from '../xtream/toChannels.ts';
import {
  REFRESH_WHATS, clearRefreshFailure, countsAsRefreshFailure, recordRefreshFailure, refreshBackedOff, refreshFailKey,
  type RefreshWhat,
} from './refreshBackoff.ts';

export type NewSource = Omit<XtreamSourceConfig, 'id'> | Omit<M3uSourceConfig, 'id'>;
export type Progress = (p: { phase: 'playlist' | 'epg'; count: number }) => void;
/** `automatic`: a background refresh (its failure records the refresh backoff); a manual one records nothing. */
export interface RefreshOptions { automatic?: boolean }
export interface IngestResult {
  channelCount: number; skipped: number; movieCount?: number; seriesCount?: number;
  /** Xtream: the account has no live streams, and its movie or series categories were found (the titles load lazily). */
  vodCatalogue?: true;
}
type IngestVod = Record<VodKind, VodList>;
export interface EpgResult { programmes: number; skipped: number }
export interface SourceServiceDeps {
  storage: Storage;
  fetch: FetchFn;
  now?: () => number;
  /** Minimum time between two short-EPG requests to one source (default `SHORT_EPG_GAP_MS`; tests pass 0). */
  shortEpgGapMs?: number;
  newId?: () => string;
  /** Playlist/XMLTV body inactivity timeout (default `BODY_IDLE_MS`). */
  bodyIdleMs?: number;
  /** Refusal cooldown shared by every request to a source (default: one built on `storage`). */
  guard?: RefusalGuard;
}

const PROGRESS_EVERY = 2000;
const EPG_BATCH = 5000;
interface TitleIndexRecord { gen: number; data: TitleIndexData; truncated: boolean }
const titleIndexKey = (id: string) => `titleIndex:${id}`;
const sportsIndexKey = (id: string) => `sportsIndex:${id}`;
/** Short-EPG requests in flight at once, across all sources (spec 2026-10-15-gentle-source §3.2). */
const SHORT_EPG_CONCURRENCY = 1;
/** Short-EPG lookups waiting for the slot; past this the oldest waiters are dropped (they resolve to nothing). */
const SHORT_EPG_QUEUE_CAP = 4;
/** At least this long between two short-EPG requests to the same source. */
const SHORT_EPG_GAP_MS = 2000;
/** Wraps an error of the guide body stream, so it can be told apart from a parse error. */
class StreamFailure extends Error {
  constructor(readonly cause: unknown) {
    super('stream failure');
  }
}
/** The guide body was read in full but is not an XMLTV document. */
class GuideUnreadable extends Error {}

async function* streamFailures(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  const it = chunks[Symbol.asyncIterator]();
  try {
    for (;;) {
      let r: IteratorResult<string>;
      try {
        r = await it.next();
      } catch (err) {
        throw new StreamFailure(err);
      }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    // Early exit (parse error, storage failure): release the body.
    await it.return?.(undefined);
  }
}

const defaultId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class SourceService {
  private readonly storage: Storage;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly bodyIdleMs: number;
  /** Every request to a source goes through it: nothing is sent while the source is in its refusal cooldown. */
  readonly guard: RefusalGuard;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly epgRefreshing = new Set<string>();
  private shortEpgActive = 0;
  private readonly shortEpgWaiting: ((granted: boolean) => void)[] = [];
  private readonly shortEpgGapMs: number;
  /** Clock ms of the last short-EPG request per source (for the gap). */
  private readonly shortEpgLastAt = new Map<string, number>();

  constructor(deps: SourceServiceDeps) {
    this.storage = deps.storage;
    this.fetchFn = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.shortEpgGapMs = deps.shortEpgGapMs ?? SHORT_EPG_GAP_MS;
    this.newId = deps.newId ?? defaultId;
    this.bodyIdleMs = deps.bodyIdleMs ?? BODY_IDLE_MS;
    this.guard = deps.guard ?? new RefusalGuard({ storage: this.storage, now: this.now });
  }

  listSources(): Promise<SourceConfig[]> {
    return this.storage.listSources();
  }

  async getActiveSourceId(): Promise<string | undefined> {
    return (await this.storage.getMeta<string>('activeSource')) ?? undefined;
  }

  setActiveSource(id: string): Promise<void> {
    return this.storage.setMeta('activeSource', id);
  }

  async addSource(input: NewSource, onProgress?: Progress) {
    let source = withCleanHttpSettings({ ...input, id: this.newId() } as SourceConfig);
    const { channels, result, vod, account } = await this.fetchChannels(source, onProgress);
    source = withAccount(source, account);
    try {
      await this.saveChannels(source.id, channels, result, vod);
      await this.storage.putSource(source);
      if (!(await this.getActiveSourceId())) await this.setActiveSource(source.id);
    } catch (err) {
      try {
        await this.storage.deleteSource(source.id);
        if ((await this.getActiveSourceId()) === source.id) await this.storage.setMeta('activeSource', null);
      } catch {
        // Best-effort cleanup; the original error is the one worth reporting.
      }
      throw err;
    }
    return { source, result };
  }

  /** `userAgent` and `referrer` are stored trimmed and capped (absent when empty); the account limit comes from the login. */
  updateSource(input: SourceConfig, onProgress?: Progress): Promise<IngestResult> {
    return this.withLock(input.id, async () => {
      let source = withCleanHttpSettings(input);
      const prev = (await this.storage.listSources()).find((s) => s.id === source.id);
      const { channels, result, vod, account } = await this.fetchChannels(source, onProgress);
      source = withAccount(source, account);
      await this.storage.putSource(source);
      // Another configuration: earlier failures say nothing about it, so automatic refreshes start afresh.
      for (const what of REFRESH_WHATS) await clearRefreshFailure(this.storage, source.id, what);
      await this.saveChannels(source.id, channels, result, vod);
      await this.storage.setMeta(`epgAt:${source.id}`, 0);
      if (source.kind === 'xtream') {
        // Another server or account: its stream ids mean nothing here, so the old catalogues must go.
        const moved = prev?.kind !== 'xtream'
          || normalizeServer(prev.server) !== normalizeServer(source.server)
          || prev.username !== source.username;
        // M3U catalogues are re-stored by saveChannels; Xtream ones are fetched lazily, so make them stale.
        for (const kind of ['movie', 'series'] as const) {
          if (moved) await this.storage.replaceVod(source.id, kind, emptyVodList());
          await this.storage.setMeta(`vodAt:${kind}:${source.id}`, 0);
        }
      }
      return result;
    });
  }

  deleteSource(id: string): Promise<void> {
    return this.withLock(id, async () => {
      await this.storage.clearProgrammes(await this.currentEpgKey(id));
      const staging = await this.stagingGen(id);
      if (staging !== undefined) await this.storage.clearProgrammes(`${id}@${staging}`);
      await this.storage.deleteSource(id);
      await this.guard.forget(id);
      // These keys do not end in the source id, so storage's per-source cleanup misses them.
      for (const what of REFRESH_WHATS) await this.storage.setMeta(refreshFailKey(id, what), null);
      // Lock order is always `id` then `layout:<id>`. Taking the layout lock waits out a layout write that had
      // already seen the source, then removes whatever it left behind; later writes see no source and no-op.
      await this.withLock(`layout:${id}`, async () => {
        for (const key of [`layout:${id}`, `flags:${id}`]) {
          if ((await this.storage.getMeta<unknown>(key)) != null) await this.storage.setMeta(key, null);
        }
      });
      if ((await this.getActiveSourceId()) === id) {
        const [next] = await this.storage.listSources();
        await this.storage.setMeta('activeSource', next?.id ?? null);
      }
    });
  }

  /**
   * Fetches and stores the playlist. Always runs (the backoff only gates `needsPlaylistRefresh`). An automatic
   * refresh that fails with a non-refusal error records the backoff; any success clears it.
   */
  refreshPlaylist(id: string, onProgress?: Progress, opts: RefreshOptions = {}): Promise<IngestResult> {
    return this.withLock(id, () => this.withBackoff(id, 'playlist', opts, async () => {
      const source = await this.requireSource(id);
      const { channels, result, vod, account } = await this.fetchChannels(source, onProgress);
      const stored = (await this.storage.listSources()).find((s) => s.id === id);
      if (!stored) return { channelCount: 0, skipped: 0 };
      // An empty Xtream answer never replaces a stored channel list (a provider hiccup must not wipe Live TV).
      // An M3U answer needs no guard: fetchChannels rejects one with nothing, and one with only movies or series is valid.
      if (source.kind === 'xtream' && channels.length === 0 && (await this.storage.getChannels(id)).length > 0) {
        throw new SourceNetworkError('The account has no live channels.');
      }
      await this.saveChannels(id, channels, result, vod);
      if (stored.kind === 'xtream') {
        const next = withAccount(stored, account);
        if (next.kind === 'xtream'
          && (next.maxConnections !== stored.maxConnections || next.activeConnections !== stored.activeConnections)) {
          await this.storage.putSource(next);
        }
      }
      return result;
    }));
  }

  async getSettings(): Promise<AppSettings> {
    return sanitizeSettings(await this.storage.getMeta<unknown>('settings'));
  }

  async saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
    const next = sanitizeSettings({ ...(await this.getSettings()), ...defined });
    await this.storage.setMeta('settings', next);
    return next;
  }

  /** Drops channels and guide data (with its coverage); the source and the user's layout stay. */
  clearCachedData(id: string): Promise<void> {
    return this.withLock(id, async () => {
      await this.requireSource(id);
      const current = await this.currentGen(id);
      const staging = await this.stagingGen(id);
      await this.storage.clearProgrammes(id);
      if (current !== undefined) await this.storage.clearProgrammes(`${id}@${current}`);
      if (staging !== undefined) await this.storage.clearProgrammes(`${id}@${staging}`);
      await this.storage.setMeta(`epgGen:${id}`, null);
      await this.storage.setMeta(`epgStaging:${id}`, null);
      await this.storage.setMeta(`epgCoverage:${id}`, null);
      await this.storage.setMeta(titleIndexKey(id), null);
      await this.storage.setMeta(sportsIndexKey(id), null);
      await this.storage.replaceChannels(id, []);
      await this.storage.setMeta(`playlistAt:${id}`, 0);
      await this.storage.setMeta(`epgAt:${id}`, 0);
      // Movies and series are cached data too; progress, favourites and watched marks (VOD user state) are kept.
      for (const kind of ['movie', 'series'] as const) {
        await this.storage.replaceVod(id, kind, emptyVodList());
        await this.storage.setMeta(`vodAt:${kind}:${id}`, 0);
      }
    });
  }

  /**
   * Whether an automatic refresh should fetch the playlist: never fetched, or stale by `autoRefreshHours`, and not
   * held off after a failed refresh (`refreshBackedOff`). Manual refreshes do not ask.
   */
  async needsPlaylistRefresh(id: string): Promise<boolean> {
    if (await this.refreshBackedOff(id, 'playlist')) return false;
    const at = (await this.storage.getMeta<number>(`playlistAt:${id}`)) ?? 0;
    if (!at) return true;
    const hours = (await this.getSettings()).autoRefreshHours;
    if (hours === 0) return false;
    return this.now() - at > hours * 3600_000;
  }

  /** As `needsPlaylistRefresh`, for the guide. */
  async needsEpgRefresh(id: string): Promise<boolean> {
    if (await this.refreshBackedOff(id, 'epg')) return false;
    const at = (await this.storage.getMeta<number>(`epgAt:${id}`)) ?? 0;
    if (!at) return true;
    const hours = (await this.getSettings()).autoRefreshHours;
    if (hours === 0) return false;
    return this.now() - at > hours * 3600_000;
  }

  /** Whether the next automatic refresh of `what` must still wait after a failed one (15 min, 1 h, then 6 h). */
  refreshBackedOff(id: string, what: RefreshWhat): Promise<boolean> {
    return refreshBackedOff(this.storage, id, what, this.now());
  }

  async loadIndex(id: string): Promise<ChannelIndex> {
    const [channels, layout, coverage] = await Promise.all([
      this.storage.getChannels(id),
      this.loadLayout(id),
      this.loadEpgCoverage(id),
    ]);
    return new ChannelIndex(channels, layout, coverage);
  }

  /**
   * The stored layout of source `id`, repaired with `normalizeLayout`. Without one, v1 `flags:<id>` are
   * migrated (and the result persisted); otherwise an empty layout.
   */
  loadLayout(id: string): Promise<Layout> {
    // Read, migrate and write under the layout lock, so a concurrent save can never be overwritten.
    return this.withLock(`layout:${id}`, async () => {
      const stored = await this.storage.getMeta<unknown>(`layout:${id}`);
      if (stored !== undefined && stored !== null) return normalizeLayout(stored);
      const flags = await this.storage.getMeta<unknown>(`flags:${id}`);
      if (!isUserFlags(flags)) return emptyLayout();
      const layout = normalizeLayout(layoutFromFlags(flags));
      await this.saveLayoutLocked(id, layout);
      return layout;
    });
  }

  /**
   * Persists the layout of source `id`; a no-op once the source is gone. Layout writes are serialised on their
   * own lock, so a user's edit never waits behind a running playlist or guide download.
   */
  saveLayout(id: string, layout: Layout): Promise<void> {
    return this.withLock(`layout:${id}`, () => this.saveLayoutLocked(id, layout));
  }

  /** The write of `saveLayout`; the caller holds the `layout:<id>` lock. */
  private async saveLayoutLocked(id: string, layout: Layout): Promise<void> {
    if (!(await this.sourceExists(id))) return;
    await this.storage.setMeta(`layout:${id}`, layout);
  }

  /** epgKeys with stored guide data, or undefined when no guide has been loaded (so a no-EPG filter is skipped). */
  async loadEpgCoverage(id: string): Promise<Set<string> | undefined> {
    const keys = await this.storage.getMeta<unknown>(`epgCoverage:${id}`);
    if (!Array.isArray(keys)) return undefined;
    return new Set(keys.filter((k): k is string => typeof k === 'string'));
  }

  /** As `refreshPlaylist`, for the guide. */
  refreshEpg(id: string, onProgress?: Progress, opts: RefreshOptions = {}): Promise<EpgResult> {
    return this.withLock(id, async () => {
      this.epgRefreshing.add(id);
      try {
        return await this.withBackoff(id, 'epg', opts, () => this.refreshEpgLocked(id, onProgress));
      } finally {
        this.epgRefreshing.delete(id);
      }
    });
  }

  private async refreshEpgLocked(id: string, onProgress?: Progress): Promise<EpgResult> {
    const source = await this.requireSource(id);
    const url = source.kind === 'm3u' ? source.epgUrl : this.xtream(source).xmltvUrl();
    if (!url) {
      const leftover = await this.stagingGen(id);
      if (leftover !== undefined) {
        await this.storage.clearProgrammes(`${id}@${leftover}`);
        await this.storage.setMeta(`epgStaging:${id}`, null);
      }
      await this.storage.clearProgrammes(await this.currentEpgKey(id));
      // No guide configured: coverage is unknown rather than empty, so a no-EPG filter hides nothing.
      await this.storage.setMeta(`epgCoverage:${id}`, null);
      await this.storage.setMeta(titleIndexKey(id), null);
      await this.storage.setMeta(sportsIndexKey(id), null);
      await this.storage.setMeta(`epgAt:${id}`, this.now());
      return { programmes: 0, skipped: 0 };
    }
    const res = await this.get(source, url);
    if (!(await this.sourceExists(id))) return { programmes: 0, skipped: 0 };
    const channels = await this.storage.getChannels(id);

    const staleStaging = await this.stagingGen(id);
    const current = await this.currentGen(id);
    // After a crash between "set epgGen" and "clear epgStaging" the staging key IS the live one.
    if (staleStaging !== undefined && staleStaging !== current) {
      await this.storage.clearProgrammes(`${id}@${staleStaging}`);
    }
    const oldKey = current === undefined ? id : `${id}@${current}`;
    const newGen = (current ?? 0) + 1;
    const newKey = `${id}@${newGen}`;
    await this.storage.setMeta(`epgStaging:${id}`, newGen);

    const matcher = new EpgMatcher(channels);
    const stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 };
    const now = this.now();
    let batch: Programme[] = [];
    let stored = 0;
    const coverage = new Set<string>();
    const titles = new TitleIndexBuilder();
    const sports = new SportsIndexBuilder(now);
    let sportsOk = true;
    let storageFailure: { error: unknown } | undefined;
    const store = async (rows: Programme[]) => {
      try {
        await this.storage.addProgrammes(newKey, rows);
      } catch (error) {
        storageFailure = { error };
        throw error;
      }
    };
    try {
      for await (const item of parseXmltv(streamFailures(responseText(res, url, { idleMs: this.bodyIdleMs })), stats)) {
        if (item.type === 'channel') {
          matcher.addXmltvChannel(item.id, item.names);
          continue;
        }
        const key = matcher.resolve(item.programme.epgId);
        if (!key || !inWindow(item.programme, now)) continue;
        batch.push({ ...item.programme, epgId: key });
        titles.add(item.programme.title, key, item.programme.start, item.programme.stop);
        if (sportsOk) {
          try {
            sports.add(item.programme, item.extra, key);
          } catch {
            // Sports is optional: stop adding and store no record; the guide import goes on.
            sportsOk = false;
          }
        }
        coverage.add(key);
        if (batch.length >= EPG_BATCH) {
          await store(batch);
          stored += batch.length;
          batch = [];
          onProgress?.({ phase: 'epg', count: stored });
        }
      }
      // Parser errors and nothing usable at all: this is not an XMLTV document (an HTML or JSON error page).
      if (stats.channels === 0 && stats.programmes === 0 && stats.skipped > 0) throw new GuideUnreadable();
      if (batch.length) await store(batch);
    } catch (err) {
      try {
        await this.storage.clearProgrammes(newKey);
        await this.storage.setMeta(`epgStaging:${id}`, null);
      } catch {
        // Best-effort cleanup; the original failure is the one worth reporting.
      }
      if (storageFailure) throw (storageFailure as { error: unknown }).error;
      if (err instanceof StreamFailure) {
        // Our own neutral messages (stalled body, compressed list on an old TV) are kept.
        if (err.cause instanceof SourceNetworkError) throw err.cause;
        throw new SourceNetworkError('The guide download was interrupted.');
      }
      // Anything else came from reading the document itself.
      throw new SourceNetworkError('The TV guide could not be read.');
    }
    stored += batch.length;
    onProgress?.({ phase: 'epg', count: stored });
    // Written before the generation switch: a crash in between leaves a record for a gen that never went live,
    // which titleIndexFor treats as missing. Search is optional: a failed build or write (quota, value size,
    // allocation) never aborts the import; the record then reads as missing and search rebuilds it later.
    try {
      await this.storage.setMeta(titleIndexKey(id), { gen: newGen, data: titles.build(), truncated: titles.truncated } satisfies TitleIndexRecord);
    } catch {
      try {
        await this.storage.setMeta(titleIndexKey(id), null);
      } catch {
        // Best effort: an older record has another gen, so it still reads as missing.
      }
    }
    // Sports is optional too: a failed build or write never aborts the import (the record then reads as missing).
    try {
      await this.storage.setMeta(sportsIndexKey(id), sportsOk ? { gen: newGen, built: now, candidates: sports.build(), truncated: sports.truncated } satisfies SportsIndexRecord : null);
    } catch {
      try {
        await this.storage.setMeta(sportsIndexKey(id), null);
      } catch {
        // Best effort: an older record has another gen, so it still reads as missing.
      }
    }
    await this.storage.setMeta(`epgGen:${id}`, newGen);
    await this.storage.setMeta(`epgCoverage:${id}`, [...coverage]);
    await this.storage.setMeta(`epgStaging:${id}`, null);
    await this.storage.clearProgrammes(oldKey);
    await this.storage.setMeta(`epgAt:${id}`, now);
    return { programmes: stored, skipped: stats.skipped };
  }

  /** The stored title index of the live guide generation, or undefined (missing, stale or malformed). */
  async titleIndexFor(id: string): Promise<TitleIndexData | undefined> {
    const rec = await this.storage.getMeta<Partial<TitleIndexRecord> | null>(titleIndexKey(id));
    if (!rec || typeof rec !== 'object') return undefined;
    if (rec.gen !== ((await this.currentGen(id)) ?? 0) || !isTitleIndexData(rec.data)) return undefined;
    return rec.data;
  }

  /** The stored sports candidates of the live guide generation, or undefined (missing, stale or malformed). */
  async sportsIndexFor(id: string): Promise<SportsIndexRecord | undefined> {
    const rec = await this.storage.getMeta<unknown>(sportsIndexKey(id));
    if (!isSportsIndexRecord(rec)) return undefined;
    return rec.gen === ((await this.currentGen(id)) ?? 0) ? rec : undefined;
  }

  /** Builds the title index from the stored guide (guides imported before it existed, or a bad record). */
  rebuildTitleIndex(id: string): Promise<void> {
    return this.withLock(id, async () => {
      if (!(await this.sourceExists(id))) return;
      if (await this.titleIndexFor(id)) return; // a guide refresh queued before us already wrote one
      const gen = await this.currentGen(id);
      const builder = new TitleIndexBuilder();
      await this.storage.forEachProgramme(gen === undefined ? id : `${id}@${gen}`, (p) => builder.add(p.title, p.epgId, p.start, p.stop));
      const record: TitleIndexRecord = { gen: gen ?? 0, data: builder.build(), truncated: builder.truncated };
      await this.storage.setMeta(titleIndexKey(id), record);
    });
  }

  async programmesFor(id: string, channels: Channel[], from: number, to: number): Promise<Map<string, Programme[]>> {
    const keys = channels.map(epgKey);
    const progs = await this.storage.getProgrammes(await this.currentEpgKey(id), keys, from, to);
    const byKey = new Map<string, Programme[]>();
    for (const p of progs) {
      const list = byKey.get(p.epgId) ?? [];
      list.push(p);
      byKey.set(p.epgId, list);
    }
    return new Map(channels.map((c) => [c.id, byKey.get(epgKey(c)) ?? []]));
  }

  /** Now/next from stored programmes only: never touches the network (see `shortEpgFor` for the fallback). */
  async nowNextFor(id: string, channels: Channel[]): Promise<Map<string, { now?: Programme; next?: Programme }>> {
    const now = this.now();
    const stored = await this.programmesFor(id, channels, now, now + 6 * 3600_000);
    return new Map(channels.map((c) => [c.id, nowNext(stored.get(c.id) ?? [], now)]));
  }

  /** True while a guide refresh of source `id` is running. */
  isRefreshingEpg(id: string): boolean {
    return this.epgRefreshing.has(id);
  }

  /**
   * Xtream short EPG for channels without stored programmes. One request runs at a time across all calls, at least
   * `shortEpgGapMs` after the previous one to the same source, and at most `SHORT_EPG_QUEUE_CAP` wait (the oldest
   * waiters are dropped). Right before each request the lookup is skipped when `isStale(channel)` says so, when a
   * guide refresh of the source runs or when the source is gone; the client is built from the source config stored
   * at that moment, so updated credentials are used. A request that failed answers `{}` (nothing found), so callers
   * can cache it; skipped and dropped lookups, and ones the refusal guard stopped before sending, are not in the result.
   */
  async shortEpgFor(
    id: string,
    channels: Channel[],
    opts: { isStale?: (channel: Channel) => boolean } = {},
  ): Promise<Map<string, { now?: Programme; next?: Programme }>> {
    const out = new Map<string, { now?: Programme; next?: Programme }>();
    const skip = (c: Channel) => this.isRefreshingEpg(id) || this.guard.isBlocked(id) || (opts.isStale?.(c) ?? false);
    // Loads the persisted cooldown first, so a lookup right after a reload is skipped instead of queued.
    if (this.isRefreshingEpg(id) || (await this.guard.status(id)).state !== 'clear') return out;
    if ((await this.storage.listSources()).find((s) => s.id === id)?.kind !== 'xtream') return out;
    await Promise.all(channels.map(async (c) => {
      const streamId = Number(/:x(\d+)$/.exec(c.id)?.[1]);
      if (!streamId || skip(c)) return;
      if (!(await this.shortEpgSlot())) return;
      try {
        if (skip(c)) return;
        await this.shortEpgGap(id);
        const source = (await this.storage.listSources()).find((s) => s.id === id);
        if (source?.kind !== 'xtream' || skip(c)) return;
        this.shortEpgLastAt.set(id, this.now());
        const list = await this.xtream(source).shortEpg(streamId, epgKey(c));
        out.set(c.id, nowNext(list, this.now()));
      } catch (err) {
        // Refused by our own guard (blocked or probing): nothing was sent, so it counts as skipped, not cached.
        if (err instanceof SourceRefusedError) return;
        // No EPG is an acceptable outcome (the UI shows the channel without programme info): answered as nothing found.
        out.set(c.id, {});
      } finally {
        this.releaseShortEpgSlot();
      }
    }));
    return out;
  }

  // ---- internals ----

  /** Resolves true with a slot, or false when this waiter was dropped from a full queue (no slot held). */
  private shortEpgSlot(): Promise<boolean> {
    if (this.shortEpgActive < SHORT_EPG_CONCURRENCY) {
      this.shortEpgActive++;
      return Promise.resolve(true);
    }
    if (this.shortEpgWaiting.length >= SHORT_EPG_QUEUE_CAP) this.shortEpgWaiting.shift()?.(false);
    return new Promise((resolve) => this.shortEpgWaiting.push(resolve));
  }

  /** Hands the slot straight to the next waiter (the active count stays), or frees it. */
  private releaseShortEpgSlot(): void {
    const next = this.shortEpgWaiting.shift();
    if (next) next(true);
    else this.shortEpgActive--;
  }

  /** Waits until `shortEpgGapMs` has passed since the last short-EPG request to source `id`. */
  private async shortEpgGap(id: string): Promise<void> {
    const last = this.shortEpgLastAt.get(id);
    // Capped at the gap: a clock that jumped back (NTP after boot) must not sleep for hours holding the only slot.
    const wait = last === undefined ? 0 : Math.min(this.shortEpgGapMs, last + this.shortEpgGapMs - this.now());
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }

  /** Runs a refresh of `what`: a success clears its backoff record; an automatic one's counting failure adds one. */
  private async withBackoff<T>(id: string, what: RefreshWhat, opts: RefreshOptions, fn: () => Promise<T>): Promise<T> {
    let out: T;
    try {
      out = await fn();
    } catch (err) {
      if (opts.automatic && countsAsRefreshFailure(err) && (await this.sourceExists(id).catch(() => false))) {
        await recordRefreshFailure(this.storage, id, what, this.now());
      }
      throw err;
    }
    if (await this.sourceExists(id).catch(() => false)) await clearRefreshFailure(this.storage, id, what);
    return out;
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  private async sourceExists(id: string): Promise<boolean> {
    return (await this.storage.listSources()).some((x) => x.id === id);
  }

  private async currentGen(id: string): Promise<number | undefined> {
    const g = await this.storage.getMeta<number>(`epgGen:${id}`);
    return typeof g === 'number' ? g : undefined;
  }

  private async stagingGen(id: string): Promise<number | undefined> {
    const g = await this.storage.getMeta<number>(`epgStaging:${id}`);
    return typeof g === 'number' ? g : undefined;
  }

  /** Storage key of the live EPG generation; legacy (pre-generation) data lives under the bare id. */
  private async currentEpgKey(id: string): Promise<string> {
    const g = await this.currentGen(id);
    return g === undefined ? id : `${id}@${g}`;
  }

  private async requireSource(id: string): Promise<SourceConfig> {
    const s = (await this.storage.listSources()).find((x) => x.id === id);
    if (!s) throw new Error(`Unknown source ${id}`);
    return s;
  }

  private xtream(s: XtreamSourceConfig): XtreamClient {
    return new XtreamClient(s, this.guard.wrap(s.id, this.fetchFn), { idleMs: this.bodyIdleMs });
  }

  /** A playlist or XMLTV download for `source`, with its User-Agent and Referer settings (`FetchInit.sourceHeaders`). */
  private async get(source: SourceConfig, url: string): Promise<Response> {
    let res: Response;
    const sourceHeaders = sourceHeadersOf(source);
    try {
      res = await this.guard.wrap(source.id, this.fetchFn)(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...(sourceHeaders ? { sourceHeaders } : {}) });
    } catch (err) {
      // A header timeout or the refusal cooldown keeps its own message; anything else means the provider could not be reached.
      if (err instanceof SourceNetworkError || err instanceof SourceRefusedError) throw err;
      throw new SourceNetworkError('Could not reach the provider.');
    }
    if (res.status === 401 || res.status === 403) throw new SourceAuthError();
    if (!res.ok) throw new SourceNetworkError(`The provider returned an error (HTTP ${res.status}).`, res.status);
    return res;
  }

  private async fetchChannels(
    source: SourceConfig, onProgress?: Progress,
  ): Promise<{ channels: Channel[]; result: IngestResult; vod?: IngestVod; account?: XtreamAccount }> {
    if (source.kind === 'xtream') {
      const client = this.xtream(source);
      const account = await client.authenticate();
      const [categories, streams] = await Promise.all([client.liveCategories(), client.liveStreams()]);
      const channels = xtreamToChannels(source.id, client, categories, streams, 'ts');
      if (channels.length === 0) {
        // An account may offer only movies and series: accept it when either catalogue has categories.
        const [movieCats, seriesCats] = await Promise.all([
          client.vodCategories().catch(emptyIfUnsupported), client.seriesCategories().catch(emptyIfUnsupported),
        ]);
        if (movieCats.length === 0 && seriesCats.length === 0) {
          throw new SourceNetworkError('The account has no channels, movies or series.');
        }
      }
      onProgress?.({ phase: 'playlist', count: channels.length });
      const result: IngestResult = { channelCount: channels.length, skipped: 0 };
      if (channels.length === 0) result.vodCatalogue = true;
      return { channels, result, account };
    }
    const res = await this.get(source, source.playlistUrl);
    const stats: ParseStats = { entries: 0, skipped: 0 };
    const entries: M3uEntry[] = [];
    for await (const e of parseM3u(splitLines(responseText(res, source.playlistUrl, { idleMs: this.bodyIdleMs })), stats)) {
      entries.push(e);
      if (entries.length % PROGRESS_EVERY === 0) onProgress?.({ phase: 'playlist', count: entries.length });
    }
    onProgress?.({ phase: 'playlist', count: entries.length });
    const split = splitM3uVod(source.id, entries);
    const channels = m3uEntriesToChannels(source.id, split.live);
    const movieCount = split.movies.items.length;
    const seriesCount = split.series.items.length;
    if (channels.length === 0 && movieCount === 0 && seriesCount === 0) {
      throw new SourceNetworkError('The playlist contains no channels.');
    }
    const result: IngestResult = { channelCount: channels.length, skipped: stats.skipped };
    if (movieCount) result.movieCount = movieCount;
    if (seriesCount) result.seriesCount = seriesCount;
    return { channels, result, vod: { movie: split.movies, series: split.series } };
  }

  private async saveChannels(id: string, channels: Channel[], result: IngestResult, vod?: IngestVod): Promise<void> {
    await this.storage.replaceChannels(id, channels);
    if (vod) {
      for (const kind of ['movie', 'series'] as const) {
        await this.storage.replaceVod(id, kind, vod[kind]);
        await this.storage.setMeta(`vodAt:${kind}:${id}`, this.now());
      }
    }
    await this.storage.setMeta(`playlistAt:${id}`, this.now());
    await this.storage.setMeta(`parseStats:${id}`, result);
  }
}

/**
 * `source` with the connection limit and count of the login's `account` (Xtream); fields the answer lacks are dropped,
 * so a stale limit never stays. An M3U source is returned unchanged.
 */
function withAccount(source: SourceConfig, account: XtreamAccount | undefined): SourceConfig {
  if (source.kind !== 'xtream') return source;
  const { maxConnections: _max, activeConnections: _active, ...rest } = source;
  const out: XtreamSourceConfig = rest;
  if (account?.maxConnections !== undefined) out.maxConnections = account.maxConnections;
  if (account?.activeConnections !== undefined) out.activeConnections = account.activeConnections;
  return out;
}

/**
 * The VOD category probe of a live-empty Xtream account: a provider without the action answers with an HTTP error or
 * something that is not JSON, which counts as "no catalogue". A refusal (cooldown, 401/403, 429 and the other refusal
 * statuses), a rejected login or an unreachable provider is rethrown: it must reach the refusal guard's caller and the
 * user, never read as an empty account.
 */
export function emptyIfUnsupported(err: unknown): never[] {
  if (err instanceof SourceNetworkError) {
    if (err.status !== undefined && !REFUSAL_STATUSES.has(err.status)) return [];
    if (err.status === undefined && err.message === UNEXPECTED_RESPONSE) return [];
  }
  throw err;
}
